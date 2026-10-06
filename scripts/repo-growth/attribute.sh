#!/bin/bash
# The stored bytes of the objects a replay added, by path (round 17, LANE G; see replay.sh).
#
#   bash scripts/repo-growth/attribute.sh <server-dir> <base-commit> [<client-repo>]
#
# Every object reachable from the server's `data` but not from <base-commit>, with its stored (packed) size, summed by
# kind: commits, trees, and blobs by the path they first appear at (day partitions, event_map shards, status history,
# observation log, change log, other).
set -euo pipefail
SRV=$1; BASE=$2
OBJS=$(mktemp); SIZES=$(mktemp)
trap 'rm -f "$OBJS" "$SIZES"' EXIT
git -C "$SRV" rev-list --objects data "^$BASE" > "$OBJS"
git -C "$SRV" cat-file --batch-check='%(objectname) %(objecttype) %(objectsize:disk)' --batch-all-objects > "$SIZES"
python3 - "$OBJS" "$SIZES" <<'PY'
import collections, re, sys
sizes = {}
for line in open(sys.argv[2]):
    o, t, d = line.split()
    sizes[o] = (t, int(d))
total = collections.Counter(); count = collections.Counter()
for line in open(sys.argv[1]):
    parts = line.rstrip('\n').split(' ', 1)
    o, path = parts[0], parts[1] if len(parts) > 1 else ''
    t, d = sizes[o]
    if t == 'commit': k = 'commits'
    elif t == 'tree': k = 'trees'
    elif path.startswith('status/history'): k = 'status/history'
    elif re.match(r'events/\d{4}/\d\d/\d\d', path): k = 'events/day'
    elif 'event_map/' in path: k = 'event_map'
    elif path.startswith('knowledge/observations'): k = 'observations'
    elif path.startswith('changes/'): k = 'changes'
    else: k = 'other'
    total[k] += d; count[k] += 1
for k, v in total.most_common():
    print(f'{k:16s} {count[k]:6d} objs {v / 1e6:8.2f} MB')
print(f'{"TOTAL":16s} {sum(total.values()) / 1e6:8.2f} MB')
PY
