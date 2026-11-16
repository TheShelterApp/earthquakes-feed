#!/bin/bash
# Storage phase 3a, one dry-run cycle on a LOCAL worktree of `data` with a LOCAL state store (never pushed, no Worker;
# APIs.md "Repository size").
#
#   bash scripts/phase3/dryrun.sh <data-worktree> <store-dir> <out-dir> <label> <aggregate-commit> <derive-iso> <stage-iso> \
#        [--inject-side-commit] [--fail-derive] [--authoritative-check]
#
# Replays what one phase-3a aggregate job does, with the code of this checkout, a clock of your choosing
# (scripts/phase2/fake-clock.mjs) and FEED_STATE_BACKEND=fs:<store-dir> in place of the state Worker:
#  1. a fresh checkout (`git clean`), then the shadow hydrate (src/event-map-store.ts hydrate: the store's days against
#     the checkout; nothing to compare before the first persist);
#  2. the silent-change snapshot (src/live-baseline.ts);
#  3. the given real aggregate commit's changes over its parent, as aggregate.yml stages them; these still carry
#     production's round-17 hour shards, so the layout move runs next (`event-map-store.ts layout`, what aggregate.ts does
#     after its save): the first cycle moves every hour-sharded day to its day file, in one commit;
#  4. persist (every day whose canonical bytes changed is gzipped into the store; generation.json written), the
#     phase-3b staging check (off while EVENT_MAP_IN_GIT=1), the commit;
#  5. with --inject-side-commit: a lockless job's commit (a new file under knowledge/first_solutions/) lands on the
#     parent first and the aggregate commit is rebased onto it, as scripts/push-data.sh does after a rejected push; the
#     event map on disk must still be the generation's (a shadow hydrate with no mismatch), or the run fails;
#  6. derive (its prune edits the generation locally), validate, stage-data, the derive commit (--fail-derive stops
#     after the aggregate commit);
#  7. a closing shadow hydrate that must find the store identical to the checkout, and with --authoritative-check a
#     phase-3b hydrate of the committed generation into an empty directory that must give the checkout's day files
#     byte for byte.
# Every marker lands in <out-dir>/<label>/markers. Fails on any mismatch, on a persist that did not succeed, or when a
# commit stages an event-map hour shard after the move.
#
# Start the worktree at a production derive commit (a blobless clone of `data` is enough: git fetches what the cycle
# reads); consecutive cycles replay consecutive aggregate commits (git log --first-parent origin/data) and reuse the
# same store directory, as production reuses its bucket.
set -euo pipefail
FEED=$(cd "$(dirname "$0")/../.." && pwd)
W=$(cd "$1" && pwd); STORE=$2; OUTDIR=$3; LABEL=$4; AGG=$5; DERIVE_ISO=$6; STAGE_ISO=$7
shift 7
SIDE=''; FAIL=''; AUTH=''
for a in "$@"; do
  case "$a" in
    --inject-side-commit) SIDE=1 ;;
    --fail-derive) FAIL=1 ;;
    --authoritative-check) AUTH=1 ;;
    *) echo "unknown option $a"; exit 3 ;;
  esac
done
mkdir -p "$STORE"; STORE=$(cd "$STORE" && pwd)
ms() { node -e "console.log(Date.parse(process.argv[1]))" "$1"; }
DERIVE_MS=$(ms "$DERIVE_ISO"); STAGE_MS=$(ms "$STAGE_ISO"); SNAP_MS=$((DERIVE_MS - 40000)); AGG_MS=$((DERIVE_MS - 30000))
OUT=$OUTDIR/$LABEL; rm -rf "$OUT"; mkdir -p "$OUT/markers"
PUB=$OUT/public; SNAP=$OUT/snap
export FEED_STATE_BACKEND="fs:$STORE"
tsx() { (cd "$FEED" && FAKE_NOW_MS=$1 node --import "$FEED/scripts/phase2/fake-clock.mjs" --import tsx "${@:2}"); }
store() { DATA_DIR=$W FEED_STATE_MARKER_DIR=$OUT/markers/$1 tsx "$2" src/event-map-store.ts "${@:3}" 2>&1 | tee "$OUT/$1.log"; }
ok() { node -e "const m=require(process.argv[1]); process.exit(m.ok ? 0 : 1)" "$OUT/markers/$1/$2.json"; }
need_ok() { ok "$1" "$2" || { echo "FAIL: $1 $2 not ok (see $OUT/$1.log)"; exit 1; }; }
echo "=== $LABEL: aggregate ${AGG:0:10}, derive $DERIVE_ISO, stage $STAGE_ISO, store $STORE"
git -C "$W" clean -fdq
test -z "$(git -C "$W" status --porcelain)" || { echo "dirty checkout"; exit 1; }
PARENT=$(git -C "$W" rev-parse HEAD)

# 1–2. The shadow hydrate (before anything writes the checkout), the snapshot.
store hydrate-before "$SNAP_MS" hydrate
DATA_DIR=$W LIVE_BASELINE_DIR=$SNAP LIVE_BASELINE_PAGES_BASE=${PAGES_BASE:-http://127.0.0.1:9/} tsx "$SNAP_MS" src/live-baseline.ts > "$OUT/snapshot.log" 2>&1 || true

# 3. The aggregate commit's changes, then the layout move.
git -C "$W" diff --name-status --no-renames "$AGG^" "$AGG" > "$OUT/agg-paths.txt"
while IFS=$'\t' read -r st path; do
  if [ "$st" = D ]; then git -C "$W" rm -q --ignore-unmatch -- "$path"; rm -f "$W/$path"; else git -C "$W" checkout "$AGG" -- "$path"; fi
done < "$OUT/agg-paths.txt"
DATA_DIR=$W tsx "$AGG_MS" src/event-map-store.ts layout | tee "$OUT/layout.log"

# 4. persist, the staging check, the aggregate commit.
store persist "$AGG_MS" persist
need_ok persist persist
# aggregate.yml's own pathspecs (each only when present: a synthetic data branch may lack status/).
git -C "$W" add -- $(for p in knowledge status status.json .gitignore; do [ -e "$W/$p" ] && echo "$p"; done)
DATA_DIR=$W tsx "$AGG_MS" src/event-map-store.ts assert-staged
shards=$(git -C "$W" diff --cached --name-only --diff-filter=AM -- knowledge/index/event_map | grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}\.ndjson$' || true)
if [ -n "$shards" ]; then echo "FAIL: hour shard(s) staged after the layout move: $shards"; exit 1; fi
git -C "$W" commit -q -m "$(git -C "$W" log -1 --format=%s "$AGG") (phase 3a dry run)" || echo "no aggregate changes"
AGG_DONE=$(git -C "$W" rev-parse HEAD)
echo "aggregate commit ${AGG_DONE:0:12}: $(git -C "$W" diff-tree -r --no-commit-id --name-only HEAD | wc -l | tr -d ' ') paths ($(git -C "$W" diff-tree -r --no-commit-id --name-only HEAD -- knowledge/index/event_map | wc -l | tr -d ' ') event-map, generation.json $(git -C "$W" diff-tree -r --no-commit-id --name-only HEAD -- knowledge/index/generation.json | wc -l | tr -d ' '))"

# 5. A lockless commit first, the rebase push-data.sh makes.
if [ -n "$SIDE" ] && [ "$AGG_DONE" != "$PARENT" ]; then
  idx=$(mktemp); trap 'rm -f "$idx"' EXIT
  GIT_INDEX_FILE=$idx git -C "$W" read-tree "$PARENT"
  blob=$(printf 'dry run %s\n' "$LABEL" | git -C "$W" hash-object -w --stdin)
  GIT_INDEX_FILE=$idx git -C "$W" update-index --add --cacheinfo "100644,$blob,knowledge/first_solutions/dryrun-side.txt"
  side=$(git -C "$W" commit-tree "$(GIT_INDEX_FILE=$idx git -C "$W" write-tree)" -p "$PARENT" -m "first-solutions: a lockless commit (dry run)")
  git -C "$W" rebase -q "$side"
  test -z "$(git -C "$W" status --porcelain)" || { echo "FAIL: the rebase left the checkout dirty"; git -C "$W" status --short | head; exit 1; }
  store hydrate-after-rebase "$AGG_MS" hydrate
  need_ok hydrate-after-rebase hydrate
  echo "rebased onto the lockless commit ${side:0:12}: the event map on disk is still the generation's"
fi
if [ -n "$FAIL" ]; then echo "derive fails (simulated): nothing derived or committed"; exit 0; fi

# 6. derive, validate, stage-data, the derive commit.
DATA_DIR=$W PUBLIC_DIR=$PUB LIVE_BASELINE_DIR=$SNAP tsx "$DERIVE_MS" src/derive.ts > "$OUT/derive.log" 2>&1 || { tail -20 "$OUT/derive.log"; exit 1; }
grep -E '^derive: live=' "$OUT/derive.log" || true
DATA_DIR=$W PUBLIC_DIR=$PUB tsx $((DERIVE_MS + 3000)) src/validate.ts > "$OUT/validate.log" 2>&1 || { tail -20 "$OUT/validate.log"; exit 1; }
DATA_DIR=$W tsx "$STAGE_MS" src/stage-data.ts . 2>&1 | tee "$OUT/stage.log"
if git -C "$W" commit -q -m "derive: views @ $STAGE_ISO (phase 3a dry run)"; then echo "derive commit $(git -C "$W" rev-parse --short HEAD)"; else echo "no data-branch changes"; fi

# 7. The store against the committed checkout, and the phase-3b hydrate.
store hydrate-final $((DERIVE_MS + 5000)) hydrate
need_ok hydrate-final hydrate
if [ -n "$AUTH" ]; then
  R=$OUT/authoritative; mkdir -p "$R/knowledge/index"
  cp "$W/knowledge/index/generation.json" "$W/knowledge/index/head.json" "$R/knowledge/index/"
  DATA_DIR=$R FEED_STATE_MARKER_DIR=$OUT/markers/authoritative tsx $((DERIVE_MS + 6000)) src/event-map-store.ts hydrate --mode authoritative 2>&1 | tee "$OUT/authoritative.log"
  need_ok authoritative hydrate
  if diff -r "$W/knowledge/index/event_map" "$R/knowledge/index/event_map" > "$OUT/authoritative.diff"; then
    echo "authoritative hydrate: $(ls "$R/knowledge/index/event_map" | wc -l | tr -d ' ') day file(s), byte for byte the checkout's"
  else
    echo "FAIL: the authoritative hydrate differs from the checkout (see $OUT/authoritative.diff)"; exit 1
  fi
fi
echo "store: $(find "$STORE/cas" -type f 2>/dev/null | wc -l | tr -d ' ') blob(s), $(du -sk "$STORE" | cut -f1) KB"
