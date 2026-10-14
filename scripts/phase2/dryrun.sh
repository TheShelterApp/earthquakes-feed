#!/bin/bash
# Storage option 4 phase 2, one dry-run cycle on a LOCAL worktree of `data` (never pushed; APIs.md "Repository size").
#
#   bash scripts/phase2/dryrun.sh <data-worktree> <out-dir> <label> <aggregate-commit> <derive-iso> <stage-iso> \
#        [<production-derive-commit>] [--fail-derive]
#
# Replays what one aggregate job does, with the code of this checkout and a clock of your choosing (fake-clock.mjs):
# a fresh checkout (`git clean`: the unfrozen partitions of the previous cycle are not on the branch), the snapshot step
# (src/live-baseline.ts; its Pages fallback asks PAGES_BASE, default an unreachable address), the given real aggregate
# commit's changes over its parent (as aggregate.yml stages them), derive at <derive-iso>, validate, stage-data at
# <stage-iso> (after derive: a day that freezes between the two is committed by this cycle), the commit, the pin and
# sign-manifest with a throwaway key (DRYRUN_KEY_FILE: a base64 PKCS8 Ed25519 key, e.g. from
# @theshelter/signing generateEd25519KeyMaterial). --fail-derive stops after the aggregate commit (a derive that failed).
# With a production derive commit, compares this cycle's partitions with production's and the silent changes found.
#
# Start the worktree at a production derive commit: git worktree add --detach <dir> <derive-commit>; consecutive cycles
# replay consecutive aggregate commits (git log --first-parent origin/data).
set -euo pipefail
FEED=$(cd "$(dirname "$0")/../.." && pwd)
W=$(cd "$1" && pwd); OUTDIR=$2; LABEL=$3; AGG=$4; DERIVE_ISO=$5; STAGE_ISO=$6; PROD=${7:-}; FAIL=${8:-}
: "${DRYRUN_KEY_FILE:?set DRYRUN_KEY_FILE to a throwaway base64 PKCS8 Ed25519 key}"
ms() { node -e "console.log(Date.parse(process.argv[1]))" "$1"; }
DERIVE_MS=$(ms "$DERIVE_ISO"); STAGE_MS=$(ms "$STAGE_ISO"); SNAP_MS=$((DERIVE_MS - 40000))
OUT=$OUTDIR/$LABEL; rm -rf "$OUT"; mkdir -p "$OUT"
PUB=$OUT/public; SNAP=$OUT/snap
tsx() { (cd "$FEED" && FAKE_NOW_MS=$1 node --import "$FEED/scripts/phase2/fake-clock.mjs" --import tsx "${@:2}"); }
echo "=== $LABEL: aggregate ${AGG:0:10}, derive $DERIVE_ISO, stage $STAGE_ISO"
git -C "$W" clean -fdq
test -z "$(git -C "$W" status --porcelain)" || { echo "dirty checkout"; exit 1; }
MONTH=$(node -e "console.log(new Date(+process.argv[1]).toISOString().slice(0, 7).replace('-', '/'))" "$STAGE_MS")
echo "checkout events/$MONTH: $(git -C "$W" ls-tree --name-only -r HEAD -- "events/$MONTH" | sed 's#.*/##' | tr '\n' ' ')"
DATA_DIR=$W LIVE_BASELINE_DIR=$SNAP LIVE_BASELINE_PAGES_BASE=${PAGES_BASE:-http://127.0.0.1:9/} tsx "$SNAP_MS" src/live-baseline.ts 2>&1 | tee "$OUT/snapshot.log"
git -C "$W" diff --name-status --no-renames "$AGG^" "$AGG" > "$OUT/agg-paths.txt"
while IFS=$'\t' read -r st path; do
  if [ "$st" = D ]; then git -C "$W" rm -q --ignore-unmatch -- "$path"; else git -C "$W" checkout "$AGG" -- "$path"; fi
done < "$OUT/agg-paths.txt"
git -C "$W" add knowledge status status.json
git -C "$W" commit -q -m "$(git -C "$W" log -1 --format=%s "$AGG") (dry run)" || echo "no aggregate changes"
if [ "$FAIL" = "--fail-derive" ]; then echo "derive fails (simulated): nothing derived, committed or deployed"; exit 0; fi
DATA_DIR=$W PUBLIC_DIR=$PUB LIVE_BASELINE_DIR=$SNAP tsx "$DERIVE_MS" src/derive.ts 2>&1 | tee "$OUT/derive.log"
DATA_DIR=$W PUBLIC_DIR=$PUB tsx $((DERIVE_MS + 3000)) src/validate.ts > "$OUT/validate.log" 2>&1 || { tail -20 "$OUT/validate.log"; exit 1; }
tail -2 "$OUT/validate.log"
DATA_DIR=$W tsx "$STAGE_MS" src/stage-data.ts . 2>&1 | tee "$OUT/stage.log"
if git -C "$W" commit -q -m "derive: views @ $STAGE_ISO (dry run)"; then echo "committed $(git -C "$W" rev-parse --short HEAD)"; else echo "no data-branch changes"; fi
SHA=$(git -C "$W" rev-parse HEAD)
node -e "const f=process.argv[1],fs=require('fs');const m=JSON.parse(fs.readFileSync(f));m.data_commit=process.argv[2];fs.writeFileSync(f,JSON.stringify(m,null,2))" "$PUB/v1/manifest.json" "$SHA"
DATA_DIR=$W PUBLIC_DIR=$PUB FEED_SIGNING_KEY=$(cat "$DRYRUN_KEY_FILE") FEED_SIGNING_KID=dryrun DATA_COMMIT=$SHA tsx $((DERIVE_MS + 6000)) src/sign-manifest.ts 2>&1 | tee "$OUT/sign.log"
added=0
for b in $(git -C "$W" diff-tree -r --no-commit-id HEAD | awk '$4 != "0000000000000000000000000000000000000000" {print $4}'); do added=$((added + $(git -C "$W" cat-file -s "$b"))); done
echo "commit $(git -C "$W" rev-parse --short HEAD): $(git -C "$W" diff-tree -r --no-commit-id --name-only HEAD | wc -l | tr -d ' ') paths, new blob bytes $added; events: $(git -C "$W" diff-tree -r --no-commit-id --name-status HEAD -- events | tr '\t\n' '  ')"
if [ -n "$PROD" ]; then
  same=0; differ=""
  for f in $(cd "$W" && git ls-files --others --cached -- 'events/*.ndjson' | sort -u); do
    if git -C "$W" cat-file -e "$PROD:$f" 2>/dev/null; then
      if cmp -s <(git -C "$W" show "$PROD:$f") "$W/$f"; then same=$((same + 1)); else differ="$differ $f"; fi
    fi
  done
  echo "vs production ${PROD:0:10}: $same partition(s) byte-identical${differ:+, differ:$differ}"
fi
