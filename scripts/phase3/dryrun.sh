#!/bin/bash
# Storage phase 3b, one dry-run cycle on a LOCAL worktree of `data` with a LOCAL state store (never pushed, no Worker;
# APIs.md "Repository size", "Phase 3b, as merged").
#
#   bash scripts/phase3/dryrun.sh <data-worktree> <store-dir> <out-dir> <label> <aggregate-commit> <derive-iso> <stage-iso> \
#        [--seed] [--inject-side-commit] [--fail-derive] [--outage hydrate|persist[:502|unavailable|hang]] [--retrack]
#
# Replays what one phase-3b aggregate job does, with the code of this checkout, a clock of your choosing
# (scripts/phase2/fake-clock.mjs) and FEED_STATE_BACKEND=fs:<store-dir> in place of the state Worker:
#  0. with --seed (once, on a worktree still in phase 3a's layout): production's blobs are not in the local store, so
#     the checkout's event map is persisted into it under the commit's own generation (every day PUT; when the days
#     equal the generation's entries, as at any production commit whose persist succeeded, generation.json is left
#     byte for byte production's, and its blobs are then production's too); a generation that had to change is
#     committed as a dry-run commit; every later cycle then reads and writes the local store only;
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
# --outage <step>[:<mode>] replays a store outage (APIs.md "Outage budget") at the hydrate (step 2) or at persist (step
# 5): that step runs against scripts/phase3/outage-store.mjs, a stand-in Worker on 127.0.0.1 that is down (default
# 502), through the real WorkerBackend and the step's production policy. The cycle passes only when the step fails
# closed: a non-zero exit, a marker that is not ok, no commit (HEAD is the parent: nothing to push), generation.json as
# committed, no day file written by a failed hydrate, and the local store untouched. The checkout is then reset, as the
# runner discards it, and nothing else runs.
# --retrack replays the rollback's derive.yml run (APIs.md "Rollback after 3b", step 3) instead of an aggregate job:
# the authoritative hydrate, `event-map-store.ts retrack` and its commit, then derive-publish (its re-hydrate keeps the
# tracked checkout) and the closing check. The retrack commit must add hour shards only, delete exactly the two
# sentinels and modify .gitignore (the ignore lines gone); <aggregate-commit> is then a production commit of phase 3a
# whose event-map tree the re-tracked one must equal, object for object (`-` for none).
#
# Start the worktree at a production derive commit of phase 3a (a blobless clone of `data` is enough: git fetches what
# the cycle reads); consecutive cycles replay consecutive aggregate commits (git log --first-parent origin/data) and
# reuse the same store directory, as production reuses its bucket. The first cycle is the transition.
set -euo pipefail
FEED=$(cd "$(dirname "$0")/../.." && pwd)
W=$(cd "$1" && pwd); STORE=$2; OUTDIR=$3; LABEL=$4; AGG=$5; DERIVE_ISO=$6; STAGE_ISO=$7
shift 7
SEED=''; SIDE=''; FAIL=''; OUTAGE=''; OUTAGE_MODE=502; RETRACK=''
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEED=1 ;;
    --inject-side-commit) SIDE=1 ;;
    --fail-derive) FAIL=1 ;;
    --outage) OUTAGE=${2%%:*}; [[ "$2" == *:* ]] && OUTAGE_MODE=${2#*:}; shift
      case "$OUTAGE" in hydrate|persist) ;; *) echo "--outage hydrate|persist[:mode]"; exit 3 ;; esac ;;
    --retrack) RETRACK=1 ;;
    *) echo "unknown option $1"; exit 3 ;;
  esac
  shift
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
# --outage: the step against the stand-in Worker that is down; passes only when it fails closed (header).
outage() {
  local label=$1 at=$2 dir=$OUT/outage rc=0 t0 secs before
  mkdir -p "$dir"
  node "$FEED/scripts/phase3/outage-store.mjs" "$OUTAGE_MODE" "$dir/port" "$dir/requests.log" & local srv=$!
  trap "kill $srv 2>/dev/null || true" EXIT
  for _ in $(seq 100); do [ -s "$dir/port" ] && break; sleep 0.05; done
  before=$(blobs); t0=$(date +%s)
  ( export FEED_STATE_BACKEND=worker FEED_STATE_URL="http://127.0.0.1:$(cat "$dir/port")" \
      ACTIONS_ID_TOKEN_REQUEST_URL="http://127.0.0.1:$(cat "$dir/port")/token" ACTIONS_ID_TOKEN_REQUEST_TOKEN=dryrun
    store "$label" "$at" "${@:3}" ) || rc=$?
  secs=$(( $(date +%s) - t0 )); kill "$srv" 2>/dev/null || true; trap - EXIT
  local bad=''
  [ "$rc" -ne 0 ] || bad="$bad; the step exited 0"
  ! ok "$label" "$3" || bad="$bad; its marker is ok"
  [ "$(git -C "$W" rev-parse HEAD)" = "$PARENT" ] || bad="$bad; HEAD moved"
  git -C "$W" diff --quiet HEAD -- knowledge/index/generation.json || bad="$bad; generation.json changed"
  [ "$(blobs)" = "$before" ] || bad="$bad; the local store changed"
  if [ "$3" = hydrate ] && [ -n "$(find "$W/$EM" -type f ! -name '0000-00-00.ndjson' ! -name '9999-12-31.ndjson' 2>/dev/null)" ]; then bad="$bad; day files written"; fi
  echo "outage ($OUTAGE_MODE) at $3: exit $rc after ${secs} s, $(grep -c . "$dir/requests.log" 2>/dev/null || echo 0) request(s) to the stand-in ($(grep -c ' /token' "$dir/requests.log" 2>/dev/null || echo 0) token), marker $(node -e "const m=require(process.argv[1]); console.log(\`ok=\${m.ok} error_kind=\${m.error_kind}\`)" "$OUT/markers/$label/$3.json")"
  if [ -n "$bad" ]; then echo "FAIL: the outage did not fail closed${bad}"; exit 1; fi
  echo "fail closed: no commit (HEAD $(git -C "$W" rev-parse --short HEAD), the parent), generation.json as committed, the store untouched$([ "$3" = hydrate ] && echo ', no day file written')"
  # The runner discards the checkout; the next cycle starts from the same commit.
  git -C "$W" reset -q --hard; git -C "$W" clean -fdq; git -C "$W" clean -fdqx -- "$EM"
  exit 0
}
tracked() { git -C "$W" ls-files -- "$EM" | { grep -v -E '/(0000-00-00|9999-12-31)\.ndjson$' || true; } | wc -l | tr -d ' '; }
echo "=== $LABEL: aggregate ${AGG:0:10}, derive $DERIVE_ISO, stage $STAGE_ISO, store $STORE"

blobs() { find "$STORE/cas" -type f -exec shasum -a 256 {} + 2>/dev/null | sort | shasum -a 256 | cut -c1-16; }

# 0. The seed: the start commit's event map into the local store, under the commit's own generation (persist PUTs every
#    day while git tracks the shards; an unchanged set of entries leaves the file as production committed it).
if [ -n "$SEED" ]; then
  test "$(tracked)" -gt 0 || { echo "FAIL: --seed needs a worktree in phase 3a's layout (hour shards tracked)"; exit 1; }
  store seed "$AGG_MS" persist
  need_ok seed persist
  if git -C "$W" diff --quiet -- knowledge/index/generation.json; then
    echo "seed: generation.json left byte for byte as committed ($(git -C "$W" rev-parse --short HEAD)): the local store holds its $(find "$STORE/cas" -type f | wc -l | tr -d ' ') blob(s)"
  else
    git -C "$W" add knowledge/index/generation.json
    git -C "$W" commit -q -m "dry run: the generation re-persisted into the local store"
    echo "seed: the committed generation lagged the checkout; re-persisted and committed as $(git -C "$W" rev-parse --short HEAD)"
  fi
fi

# 1. A fresh checkout: a job's checkout has no ignored day file (x: ignored files under the event map too).
git -C "$W" clean -fdq
git -C "$W" clean -fdqx -- "$EM"
test -z "$(git -C "$W" status --porcelain)" || { echo "dirty checkout"; exit 1; }
PARENT=$(git -C "$W" rev-parse HEAD)
TRANSITION=$(tracked)

# 2–3. The hydrate (before anything reads the event map), the snapshot.
[ "$OUTAGE" != hydrate ] || outage hydrate "$SNAP_MS" hydrate
store hydrate "$SNAP_MS" hydrate
need_ok hydrate hydrate
DATA_DIR=$W LIVE_BASELINE_DIR=$SNAP LIVE_BASELINE_PAGES_BASE=${PAGES_BASE:-http://127.0.0.1:9/} tsx "$SNAP_MS" src/live-baseline.ts > "$OUT/snapshot.log" 2>&1 || true

if [ -z "$RETRACK" ]; then
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
  [ "$OUTAGE" != persist ] || outage persist "$AGG_MS" persist
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
else
  # 4–5 (--retrack). The rollback's derive.yml run: its preconditions (writer-queue.mjs retrack-check: aggregate.yml
  # disabled, no aggregate run queued) are GitHub's and tested in tests/writer-queue.test.ts; here the hydrate above,
  # the re-track and its commit, then derive-publish below as usual.
  [ "$TRANSITION" -eq 0 ] || { echo "FAIL: --retrack on a branch whose event map git still tracks"; exit 1; }
  DATA_DIR=$W tsx "$DERIVE_MS" src/event-map-store.ts retrack | tee "$OUT/retrack.log"
  git -C "$W" commit -q -m "retrack: the event map back in git (storage phase 3b rollback) @ $DERIVE_ISO (dry run)"
  AGG_DONE=$(git -C "$W" rev-parse HEAD)
  git -C "$W" diff-tree -r --no-commit-id --name-status --no-renames HEAD > "$OUT/retrack-commit.txt"
  T=$'\t'
  bad=$(grep -v -E "^(A${T}$EM/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}\.ndjson|D${T}$EM/(0000-00-00|9999-12-31)\.ndjson|M${T}\.gitignore)\$" "$OUT/retrack-commit.txt" || true)
  [ -z "$bad" ] || { echo "FAIL: the retrack commit carries other paths: $(echo "$bad" | head -5 | tr '\n' ' ')"; exit 1; }
  [ "$(grep -c '^D' "$OUT/retrack-commit.txt")" -eq 2 ] || { echo "FAIL: the retrack commit must delete both sentinels"; exit 1; }
  ! git -C "$W" show HEAD:.gitignore | grep -E "^!?$EM/" || { echo "FAIL: .gitignore still ignores the event map"; exit 1; }
  echo "retrack commit ${AGG_DONE:0:12}: $(grep -c '^A' "$OUT/retrack-commit.txt") hour shard(s) added ($(git -C "$W" ls-tree -r -l HEAD -- "$EM" | awk '{s+=$4} END {printf "%.1f", s/1e6}') MB), both sentinels deleted, .gitignore without the event-map lines"
  if [ "$AGG" != - ]; then
    mine=$(git -C "$W" rev-parse "HEAD:$EM"); theirs=$(git -C "$W" rev-parse "$AGG:$EM")
    if [ "$mine" = "$theirs" ]; then
      echo "the re-tracked event map is production's ${AGG:0:12} tree, object for object (tree $mine)"
    else
      git -C "$W" diff --name-status "$AGG" HEAD -- "$EM" > "$OUT/retrack-vs-production.txt"
      echo "FAIL: the re-tracked event map differs from production's ${AGG:0:12}: $(wc -l < "$OUT/retrack-vs-production.txt" | tr -d ' ') path(s) (see $OUT/retrack-vs-production.txt)"; exit 1
    fi
  fi
fi

# 6. A lockless commit first, the rebase push-data.sh makes, derive-publish's re-hydrate.
if [ -n "$SIDE" ] && [ -z "$RETRACK" ] && [ "$AGG_DONE" != "$PARENT" ]; then
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
if [ -n "$RETRACK" ]; then
  # After the re-track git is the truth again: the re-hydrate keeps the tracked checkout (nothing fetched or written).
  grep -q 'git still tracks .* nothing fetched' "$OUT/rehydrate.log" || { echo "FAIL: derive-publish's re-hydrate after the retrack did not keep the tracked checkout"; exit 1; }
else
  grep -q ', 0 fetched' "$OUT/rehydrate.log" || { echo "FAIL: derive-publish's re-hydrate had to fetch (a day file lost on disk)"; exit 1; }
fi
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
