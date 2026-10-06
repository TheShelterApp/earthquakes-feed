#!/usr/bin/env python3
"""Re-create a range of real `data` commits, content for content, optionally in another layout (round 17, LANE G).

    python3 scripts/repo-growth/relayout.py <src-repo> <tip> <base> <out-repo> <out-branch> [options]

Writes <out-repo> (a bare repository borrowing <src-repo>'s objects) with <out-branch> = a parentless copy of <base>'s
tree followed by one commit per first-parent commit of <base>..<tip> (same message, author, committer and time), so
replay.sh can push the range from a shallow data checkout. Without options the trees are exactly the originals'.

Options (the layouts measured for APIs.md "Repository size"):
  --status-days          the status history the way round 17 writes it: status/history/YYYY-MM.ndjson stays as it was
                         at <base>, every line appended after it goes to status/history/YYYY-MM-DD.ndjson (the day of
                         the line's `generated`).
  --status-pad REV:PATH  prefix the month file with the blob REV:PATH (a month file as it is late in the month).
  --event-map-hours N    knowledge/index/event_map/YYYY-MM-DD.ndjson becomes YYYY-MM-DD-HH.ndjson shards of N hours of
                         event time, lines in feed-id order; only shards whose bytes change are written (round 17).
  --partition-hold H:A   a day partition events/YYYY/MM/DD.ndjson of a day at least A days before the commit's day is
                         written at most once every H hours, then with its newest content (a layout NOT adopted: an
                         owner decision, APIs.md "Repository size").
"""
import re, subprocess, sys
from collections import defaultdict
from datetime import datetime, timezone

args = sys.argv[1:]
src, branch, base, out, outbranch = args[:5]
opt = lambda k: args[args.index(k) + 1] if k in args else None
status_days = '--status-days' in args
status_pad = opt('--status-pad')
em_hours = int(opt('--event-map-hours') or 0)
hold = opt('--partition-hold')
hold_s, hold_age = (int(hold.split(':')[0]) * 3600, int(hold.split(':')[1])) if hold else (0, 0)

def git(*a):
    return subprocess.run(['git', '-C', src, *a], capture_output=True, check=True).stdout

cat = subprocess.Popen(['git', '-C', src, 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def blob(sha):
    cat.stdin.write((sha + '\n').encode()); cat.stdin.flush()
    hdr = cat.stdout.readline().split(); n = int(hdr[2]); data = cat.stdout.read(n); cat.stdout.read(1)
    return data

subprocess.run(['git', 'init', '-q', '--bare', out], check=True)
with open(f'{out}/objects/info/alternates', 'w') as f:
    f.write(subprocess.run(['git', '-C', src, 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], capture_output=True, text=True, check=True).stdout.strip() + '\n')
fi = subprocess.Popen(['git', '-C', out, 'fast-import', '--quiet', '--done'], stdin=subprocess.PIPE)
w = fi.stdin.write

STATUS_RE = re.compile(r'^status/history/(\d{4}-\d{2})\.ndjson$')
EM_RE = re.compile(r'^knowledge/index/event_map/(\d{4}-\d{2}-\d{2})\.ndjson$')
PART_RE = re.compile(r'^events/(\d{4})/(\d{2})/(\d{2})\.ndjson$')
TIME_RE = re.compile(rb'"eventTimeMs":(-?\d+)')
GEN_RE = re.compile(rb'^\{"generated":"(\d{4}-\d{2}-\d{2})')

def inline(path, data):
    w(f'M 100644 inline {path}\n'.encode()); w(f'data {len(data)}\n'.encode()); w(data); w(b'\n')

status_prev = {}                 # month path -> bytes at the previous commit (original layout)
status_day = defaultdict(bytes)  # day -> accumulated bytes
pad = b''
em_buckets = {}                  # day -> {bucket -> bytes}
part_written = {}                # partition path -> commit time of its last write
part_pending = {}                # partition path -> (mode, sha) not yet written

def em_split(day, data):
    b = defaultdict(list)
    for line in data.split(b'\n'):
        if not line.strip():
            continue
        h = (int(TIME_RE.search(line).group(1)) // 3_600_000) % 24
        b[f'{day}-{h - h % em_hours:02d}'].append(line)
    return {k: b'\n'.join(v) + b'\n' for k, v in b.items()}

def em_write(day, new):
    old = em_buckets.get(day, {})
    for k in old:
        if k not in new:
            w(f'D knowledge/index/event_map/{k}.ndjson\n'.encode())
    for k, v in new.items():
        if old.get(k) != v:
            inline(f'knowledge/index/event_map/{k}.ndjson', v)
    em_buckets[day] = new

def header(c):
    meta = git('log', '-1', '--format=%an%x00%ae%x00%at %ad%x00%cn%x00%ce%x00%ct%x00%B', '--date=format:%z', c).decode()
    an, ae, adate, cn, ce, ct, msg = meta.split('\x00', 6)
    w(f'commit refs/heads/{outbranch}\n'.encode())
    w(f'author {an} <{ae}> {adate}\n'.encode())
    w(f'committer {cn} <{ce}> {ct} +0000\n'.encode())
    m = msg.encode(); w(f'data {len(m)}\n'.encode()); w(m); w(b'\n')
    return int(ct)

# Base: the whole tree, transformed.
header(base)
w(b'deleteall\n')
if status_pad:
    pad = blob(git('rev-parse', status_pad).decode().strip())
for line in git('ls-tree', '-r', '--full-tree', base).decode().splitlines():
    meta, path = line.split('\t', 1)
    mode, typ, sha = meta.split()
    if STATUS_RE.match(path):
        status_prev[path] = blob(sha)
        if status_pad:
            inline(path, pad + status_prev[path])
            continue
    em = EM_RE.match(path)
    if em and em_hours:
        em_write(em.group(1), em_split(em.group(1), blob(sha)))
        continue
    w(f'M {mode} {sha} {path}\n'.encode())
w(b'\n')

commits = git('rev-list', '--reverse', '--first-parent', f'{base}..{branch}').decode().split()
for c in commits:
    ct = header(c)
    today = datetime.fromtimestamp(ct, timezone.utc).date()
    for line in git('diff-tree', '-r', '--no-renames', '--no-commit-id', '--raw', c + '^', c).decode().splitlines():
        meta, path = line.split('\t', 1)
        _om, nm, _os, ns, st = meta[1:].split()
        m = STATUS_RE.match(path)
        em = EM_RE.match(path)
        pm = PART_RE.match(path)
        if m and (status_days or status_pad) and st == 'D':
            # The archive moved a finished month out of the tree (LIVE-2): its file goes (and so would its day files).
            w(f'D {path}\n'.encode())
            status_prev.pop(path, None)
            continue
        if m and (status_days or status_pad):
            data = blob(ns)
            prev = status_prev.get(path, b'')
            assert data.startswith(prev), 'status history is append-only'
            if status_days:
                touched = set()
                for ln in data[len(prev):].split(b'\n'):
                    if ln.strip():
                        day = GEN_RE.match(ln).group(1).decode()
                        status_day[day] += ln + b'\n'
                        touched.add(day)
                for day in sorted(touched):
                    inline(f'status/history/{day}.ndjson', status_day[day])
            else:
                inline(path, pad + data)
            status_prev[path] = data
            continue
        if em and em_hours:
            day = em.group(1)
            em_write(day, {} if st == 'D' else em_split(day, blob(ns)))
            continue
        if pm and hold_s and st != 'D':
            age = (today - datetime(int(pm.group(1)), int(pm.group(2)), int(pm.group(3))).date()).days
            if age >= hold_age and ct - part_written.get(path, 0) < hold_s:
                part_pending[path] = (nm, ns)
                continue
            part_written[path] = ct
            part_pending.pop(path, None)
        if st == 'D':
            w(f'D {path}\n'.encode())
        else:
            w(f'M {nm} {ns} {path}\n'.encode())
    # A held partition whose hold is over is written by the next derive run, changed in this run or not.
    if hold_s and git('log', '-1', '--format=%s', c).startswith(b'derive'):
        for path, (nm, ns) in list(part_pending.items()):
            if ct - part_written.get(path, 0) >= hold_s:
                w(f'M {nm} {ns} {path}\n'.encode())
                part_written[path] = ct
                del part_pending[path]
    w(b'\n')
w(b'done\n')
fi.stdin.close()
fi.wait()
print(len(commits), 'commits replayed into', out, outbranch, 'pending at the end:', len(part_pending))
