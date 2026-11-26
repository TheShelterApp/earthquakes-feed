#!/bin/bash
# Storage phase 3b, one dry-run cycle on a LOCAL worktree of `data` with a LOCAL state store (never pushed, no Worker;
# APIs.md "Repository size", "Phase 3b, as merged").
#
#   bash scripts/phase3/dryrun.sh <data-worktree> <store-dir> <out-dir> <label> <aggregate-commit> <derive-iso> <stage-iso> \
#        [--seed] [--inject-side-commit] [--fail-derive]
#
# Replays what one phase-3b aggregate job does, with the code of this checkout, a clock of your choosing
# (scripts/phase2/fake-clock.mjs) and FEED_STATE_BACKEND=fs:<store-dir> in place of the state Worker:
#  0. with --seed (once, on a worktree still in phase 3a's layout): production's blobs are not in the local store, so
#     the checkout's event map is persisted into it under a fresh generation (persist with no previous one), committed
#     as a dry-run commit; every later cycle then reads and writes the local store only;
#  1. a fresh checkout: `git clean`, and the ignored day files removed (a job's checkout has none since the transition);
#  2. the hydrate (src/event-map-store.ts hydrate, authoritative: the generation's days fetched into the checkout; while
#     git still tracks the hour shards, the transition cycle, the checkout is kept and compared);
#  3. the silent-change snapshot (src/live-baseline.ts), after the hydrate;
#  4. the given real aggregate commit's changes over its parent (a phase-3a commit: hour shards): every other path but
#     generation.json (the replay's own, of local blobs) as production committed it; each event-map day it touched rebuilt from that commit's files of the day, as hour shards
#     while git tracks them (the transition cycle), else as the canonical day file (phase 3b's saveEventMap);
#  5. persist, then aggregate.yml's commit step: `stage` (the transition and the layout move), the `git add`,
#     `assert-staged`, the commit; the cycle fails when the commit adds or modifies an event-map path but a sentinel,
#     or, after the transition, touches the event map at all;
#  6. with --inject-side-commit: a lockless job's commit (a new file under knowledge/first_solutions/) lands on the
#     parent first and the aggregate commit is rebased onto it, as scripts/push-data.sh does after a rejected push;
#     derive-publish's re-hydrate must then find every day on disk (nothing fetched), or the cycle fails;
#  7. derive (its prune edits the generation and deletes the day files below the horizon), validate, stage-data, the
#     derive commit (--fail-derive stops after the aggregate commit);
#  8. a closing check: an authoritative hydrate of the committed generation into an empty directory must give, byte for
#     byte, the checkout's days.
# Every marker lands in <out-dir>/<label>/markers.
#
# Start the worktree at a production derive commit of phase 3a (a blobless clone of `data` is enough: git fetches what
# the cycle reads); consecutive cycles replay consecutive aggregate commits (git log --first-parent origin/data) and
# reuse the same store directory, as production reuses its bucket. The first cycle is the transition.
set -euo pipefail
FEED=$(cd "$(dirname "$0")/../.." && pwd)
W=$(cd "$1" && pwd); STORE=$2; OUTDIR=$3; LABEL=$4; AGG=$5; DERIVE_ISO=$6; STAGE_ISO=$7
shift 7
SEED=''; SIDE=''; FAIL=''
for a in "$@"; do
  case "$a" in
    --seed) SEED=1 ;;
    --inject-side-commit) SIDE=1 ;;
    --fail-derive) FAIL=1 ;;
    *) echo "unknown option $a"; exit 3 ;;
  esac
done
mkdir -p "$STORE"; STORE=$(cd "$STORE" && pwd)
ms() { node -e "console.log(Date.parse(process.argv[1]))" "$1"; }
DERIVE_MS=$(ms "$DERIVE_ISO"); STAGE_MS=$(ms "$STAGE_ISO"); SNAP_MS=$((DERIVE_MS - 40000)); AGG_MS=$((DERIVE_MS - 30000))
OUT=$OUTDIR/$LABEL; rm -rf "$OUT"; mkdir -p "$OUT/markers"
PUB=$OUT/public; SNAP=$OUT/snap
EM=knowledge/index/event_map
export FEED_STATE_BACKEND="fs:$STORE"
tsx() { (cd "$FEED" && FAKE_NOW_MS=$1 node --import "$FEED/scripts/phase2/fake-clock.mjs" --import tsx "${@:2}"); }
store() { DATA_DIR=$W FEED_STATE_MARKER_DIR=$OUT/markers/$1 tsx "$2" src/event-map-store.ts "${@:3}" 2>&1 | tee "$OUT/$1.log"; }
ok() { node -e "const m=require(process.argv[1]); process.exit(m.ok ? 0 : 1)" "$OUT/markers/$1/$2.json"; }
need_ok() { ok "$1" "$2" || { echo "FAIL: $1 $2 not ok (see $OUT/$1.log)"; exit 1; }; }
tracked() { git -C "$W" ls-files -- "$EM" | { grep -v -E '/(0000-00-00|9999-12-31)\.ndjson$' || true; } | wc -l | tr -d ' '; }
echo "=== $LABEL: aggregate ${AGG:0:10}, derive $DERIVE_ISO, stage $STAGE_ISO, store $STORE"

# 0. The seed: the start commit's event map into the local store, under a generation of local blobs.
if [ -n "$SEED" ]; then
  test "$(tracked)" -gt 0 || { echo "FAIL: --seed needs a worktree in phase 3a's layout (hour shards tracked)"; exit 1; }
  rm -f "$W/knowledge/index/generation.json"
  store seed "$AGG_MS" persist
  need_ok seed persist
  git -C "$W" add knowledge/index/generation.json
  git -C "$W" commit -q -m "dry run: the generation re-persisted into the local store" || true
fi

# 1. A fresh checkout: a job's checkout has no ignored day file (x: ignored files under the event map too).
git -C "$W" clean -fdq
git -C "$W" clean -fdqx -- "$EM"
test -z "$(git -C "$W" status --porcelain)" || { echo "dirty checkout"; exit 1; }
PARENT=$(git -C "$W" rev-parse HEAD)
TRANSITION=$(tracked)

# 2–3. The hydrate (before anything reads the event map), the snapshot.
store hydrate "$SNAP_MS" hydrate
need_ok hydrate hydrate
DATA_DIR=$W LIVE_BASELINE_DIR=$SNAP LIVE_BASELINE_PAGES_BASE=${PAGES_BASE:-http://127.0.0.1:9/} tsx "$SNAP_MS" src/live-baseline.ts > "$OUT/snapshot.log" 2>&1 || true

# 4. The aggregate commit's changes: every path but the event map as production committed it; each touched event-map
#    day rebuilt from that commit's files of the day.
git -C "$W" diff --name-status --no-renames "$AGG^" "$AGG" > "$OUT/agg-paths.txt"
days=''
while IFS=$'\t' read -r st path; do
  case "$path" in
    "$EM"/*)
      days="$days ${path:${#EM}+1:10}"
      if [ "$TRANSITION" -gt 0 ]; then
        if [ "$st" = D ]; then git -C "$W" rm -q --ignore-unmatch -- "$path"; rm -f "$W/$path"; else git -C "$W" checkout "$AGG" -- "$path"; fi
      fi
      ;;
    # The generation is this replay's own (local blobs): persist below writes it.
    knowledge/index/generation.json) ;;
    *) if [ "$st" = D ]; then git -C "$W" rm -q --ignore-unmatch -- "$path"; rm -f "$W/$path"; else git -C "$W" checkout "$AGG" -- "$path"; fi ;;
  esac
done < "$OUT/agg-paths.txt"
if [ "$TRANSITION" -eq 0 ] && [ -n "$days" ]; then
  (cd "$FEED" && node --import tsx --input-type=module -e '
    const [w, agg, ...days] = process.argv.slice(1);
    const { execFileSync } = await import("node:child_process");
    const { rmSync, writeFileSync } = await import("node:fs");
    const { canonicalDay, dayFileName } = await import("./src/event-map-store.ts");
    const em = "knowledge/index/event_map";
    for (const day of [...new Set(days)]) {
      const names = execFileSync("git", ["-C", w, "ls-tree", "--name-only", agg, "--", `${em}/`], { encoding: "utf8" }).split("\n").filter((p) => p.slice(em.length + 1).startsWith(day));
      const file = `${w}/${em}/${dayFileName(day)}`;
      if (!names.length) { rmSync(file, { force: true }); continue; }
      writeFileSync(file, canonicalDay(names.map((p) => execFileSync("git", ["-C", w, "show", `${agg}:${p}`], { encoding: "utf8", maxBuffer: 1 << 28 }))).text);
    }' "$W" "$AGG" $days)
fi

# 5. persist, then the commit step as aggregate.yml runs it.
store persist "$AGG_MS" persist
need_ok persist persist
DATA_DIR=$W tsx "$AGG_MS" src/event-map-store.ts stage | tee "$OUT/stage.log"
# aggregate.yml's own pathspecs (each only when present: a synthetic data branch may lack status/).
git -C "$W" add -- $(for p in knowledge status status.json .gitignore; do [ -e "$W/$p" ] && echo "$p"; done)
DATA_DIR=$W tsx "$AGG_MS" src/event-map-store.ts assert-staged
bad=$(git -C "$W" diff --cached --name-only --diff-filter=AM -- "$EM" | grep -v -E '/(0000-00-00|9999-12-31)\.ndjson$' || true)
if [ -n "$bad" ]; then echo "FAIL: event-map path(s) staged: $bad"; exit 1; fi
if [ "$TRANSITION" -eq 0 ] && [ -n "$(git -C "$W" diff --cached --name-only -- "$EM")" ]; then echo "FAIL: a commit after the transition touches the event map"; exit 1; fi
git -C "$W" commit -q -m "$(git -C "$W" log -1 --format=%s "$AGG") (phase 3b dry run)" || echo "no aggregate changes"
AGG_DONE=$(git -C "$W" rev-parse HEAD)
echo "aggregate commit ${AGG_DONE:0:12}$([ "$TRANSITION" -gt 0 ] && echo " (THE TRANSITION: $TRANSITION hour shard(s) untracked)"): $(git -C "$W" diff-tree -r --no-commit-id --name-only HEAD | wc -l | tr -d ' ') paths ($(git -C "$W" diff-tree -r --no-commit-id --name-only HEAD -- "$EM" | wc -l | tr -d ' ') event-map, generation.json $(git -C "$W" diff-tree -r --no-commit-id --name-only HEAD -- knowledge/index/generation.json | wc -l | tr -d ' '))"
git -C "$W" diff-tree -r --no-commit-id --name-status --no-renames HEAD > "$OUT/agg-commit.txt"

# 6. A lockless commit first, the rebase push-data.sh makes, derive-publish's re-hydrate.
if [ -n "$SIDE" ] && [ "$AGG_DONE" != "$PARENT" ]; then
  idx=$(mktemp); trap 'rm -f "$idx"' EXIT
  GIT_INDEX_FILE=$idx git -C "$W" read-tree "$PARENT"
  blob=$(printf 'dry run %s\n' "$LABEL" | git -C "$W" hash-object -w --stdin)
  GIT_INDEX_FILE=$idx git -C "$W" update-index --add --cacheinfo "100644,$blob,knowledge/first_solutions/dryrun-side.txt"
  side=$(git -C "$W" commit-tree "$(GIT_INDEX_FILE=$idx git -C "$W" write-tree)" -p "$PARENT" -m "first-solutions: a lockless commit (dry run)")
  git -C "$W" rebase -q "$side"
  test -z "$(git -C "$W" status --porcelain)" || { echo "FAIL: the rebase left the checkout dirty"; git -C "$W" status --short | head; exit 1; }
  echo "rebased onto the lockless commit ${side:0:12}"
fi
store rehydrate "$AGG_MS" hydrate
need_ok rehydrate hydrate
grep -q ', 0 fetched' "$OUT/rehydrate.log" || { echo "FAIL: derive-publish's re-hydrate had to fetch (a day file lost on disk)"; exit 1; }
if [ -n "$FAIL" ]; then echo "derive fails (simulated): nothing derived or committed"; exit 0; fi

# 7. derive, validate, stage-data, the derive commit.
DATA_DIR=$W PUBLIC_DIR=$PUB LIVE_BASELINE_DIR=$SNAP tsx "$DERIVE_MS" src/derive.ts > "$OUT/derive.log" 2>&1 || { tail -20 "$OUT/derive.log"; exit 1; }
grep -E '^derive: live=' "$OUT/derive.log" || true
DATA_DIR=$W PUBLIC_DIR=$PUB tsx $((DERIVE_MS + 3000)) src/validate.ts > "$OUT/validate.log" 2>&1 || { tail -20 "$OUT/validate.log"; exit 1; }
DATA_DIR=$W tsx "$STAGE_MS" src/stage-data.ts . 2>&1 | tee "$OUT/stage-data.log"
if git -C "$W" commit -q -m "derive: views @ $STAGE_ISO (phase 3b dry run)"; then echo "derive commit $(git -C "$W" rev-parse --short HEAD)"; else echo "no data-branch changes"; fi

# 8. The committed generation, hydrated into an empty directory, is the checkout's event map.
R=$OUT/authoritative; mkdir -p "$R/knowledge/index"
cp "$W/knowledge/index/generation.json" "$W/knowledge/index/head.json" "$R/knowledge/index/"
DATA_DIR=$R FEED_STATE_MARKER_DIR=$OUT/markers/authoritative tsx $((DERIVE_MS + 6000)) src/event-map-store.ts hydrate 2>&1 | tee "$OUT/authoritative.log"
need_ok authoritative hydrate
if (cd "$FEED" && node --import tsx --input-type=module -e '
  const [w, r] = process.argv.slice(1);
  const { eventMapFiles, readCanonicalDay } = await import("./src/event-map-store.ts");
  const mine = eventMapFiles(w); const theirs = eventMapFiles(r); const bad = [];
  if (mine.size !== theirs.size) bad.push(`${theirs.size} day(s) hydrated for ${mine.size} in the checkout`);
  for (const [d, names] of mine) if (!theirs.has(d) || readCanonicalDay(w, names).text !== readCanonicalDay(r, theirs.get(d)).text) bad.push(d);
  if (bad.length) { console.error(bad.join("\n")); process.exit(1); }' "$W" "$R") 2> "$OUT/authoritative.diff"; then
  echo "authoritative hydrate: $(ls "$R/knowledge/index/event_map" | wc -l | tr -d ' ') file(s), byte for byte the checkout's days"
else
  echo "FAIL: the authoritative hydrate differs from the checkout (see $OUT/authoritative.diff)"; exit 1
fi
echo "store: $(find "$STORE/cas" -type f 2>/dev/null | wc -l | tr -d ' ') blob(s), $(du -sk "$STORE" | cut -f1) KB"
