#!/bin/bash
# Repository growth as GitHub stores it, measured locally (round 17, LANE G; APIs.md "Repository size").
#
#   bash scripts/repo-growth/replay.sh <client-repo> <branch> <base-commit> <server-dir> [pushes-per-repack]
#
# Pushes every commit after <base-commit> on <branch> (first parent, oldest first) one by one into a fresh bare
# repository <server-dir> that keeps every received pack (receive.unpackLimit=1) and runs `git repack -d --geometric=2`
# after every <pushes-per-repack> pushes (default 12: hourly at the feed's ~12 pushes an hour). That is how GitHub keeps
# a busy repository: each push becomes a pack, and its maintenance rolls the newest packs together, reusing the deltas
# they hold instead of searching new ones. The base commit is fetched and packed first and not counted.
#
# Prints the server's object bytes above the base every 50 pushes, the growth after the replay
# (`geometric_growth`, the figure to compare with GitHub's `size`), the growth after one all-into-one repack that
# reuses deltas (`after_all_into_one_reuse`), and the growth by path (attribute.sh).
#
# <client-repo> needs the commits' history down to <base-commit>: the data branch's checkouts are shallow, so first
# re-create the range with relayout.py (which also rewrites it into another layout when asked). Local only: nothing is
# pushed anywhere but <server-dir>.
set -euo pipefail
CLIENT=$(cd "$1" && pwd); BR=$2; BASE=$3; SRV=$4; EVERY=${5:-12}
rm -rf "$SRV"; git init -q --bare "$SRV"; SRV=$(cd "$SRV" && pwd)
git -C "$SRV" config receive.unpackLimit 1
git -C "$SRV" config gc.auto 0
# receive-pack starts `git maintenance run --auto` in the background after each push (Git 2.54: the geometric
# strategy, now and then all into one), which raced the roll-ups below ("could not find pack") and made repeated
# replays differ by about 10 MB a day. Off, so the roll-ups are this script's alone (round 17 review).
git -C "$SRV" config receive.autogc false
git -C "$SRV" config maintenance.auto false
git -C "$SRV" config repack.writeBitmaps false
git -C "$SRV" config pack.writeBitmaps false
git -C "$SRV" fetch -q "$CLIENT" "$BASE:refs/heads/data"
git -C "$SRV" repack -adq
# Bytes of every pack and loose object (no index, bitmap or reverse index files).
total() {
  python3 - "$SRV/objects" <<'PY'
import os, re, sys
n = 0
for d, _, fs in os.walk(sys.argv[1]):
    for f in fs:
        if f.endswith('.pack') or re.fullmatch(r'[0-9a-f]{2}', os.path.basename(d)):
            n += os.path.getsize(os.path.join(d, f))
print(n)
PY
}
B0=$(total)
echo "base $B0"
i=0
for c in $(git -C "$CLIENT" rev-list --reverse --first-parent "$BASE..$BR"); do
  git -C "$CLIENT" push -q "$SRV" "$c:refs/heads/data" 2>/dev/null
  i=$((i + 1))
  # A failed roll-up is retried once; a failed retry only leaves the packs as they are.
  if [ $((i % EVERY)) -eq 0 ]; then git -C "$SRV" repack -dq --geometric=2 || git -C "$SRV" repack -dq --geometric=2 || true; fi
  if [ $((i % 50)) -eq 0 ]; then echo "$i $(($(total) - B0))"; fi
done
git -C "$SRV" repack -dq --geometric=2 || true
echo "pushes=$i geometric_growth=$(($(total) - B0))"
git -C "$SRV" repack -adq
echo "after_all_into_one_reuse=$(($(total) - B0))"
echo "--- growth by path after the all-into-one repack"
bash "$(dirname "$0")/attribute.sh" "$SRV" "$BASE" "$CLIENT"
