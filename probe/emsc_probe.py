"""Temporary probe (round 23), second pass: what are the ten 2017-12 events EMSC counts but does not serialize, and
which other months have such events. At most one request every 2 s to seismicportal.eu. Writes to probe-out/."""
import json, os, re, time, urllib.request, urllib.parse, urllib.error

UA = 'earthquakes-feed-history/1.0 (+https://github.com/TheShelterApp/earthquakes-feed; deep-history backfill, one request at a time)'
BASE = 'https://www.seismicportal.eu/fdsnws/event/1/'
OUT = 'probe-out'
os.makedirs(OUT, exist_ok=True)
last = [0.0]

def get(path, params, name=None, quiet=False):
    wait = last[0] + 2.0 - time.time()
    if wait > 0: time.sleep(wait)
    url = BASE + path + '?' + urllib.parse.urlencode(params)
    t = time.time()
    req = urllib.request.Request(url, headers={'user-agent': UA, 'accept': 'application/json, text/plain, */*'})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            status, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read()
    except Exception as e:
        status, body = None, str(e).encode()
    last[0] = time.time()
    if name: open(os.path.join(OUT, name), 'wb').write(body)
    if not quiet: print(f'{name}: HTTP {status} {len(body)} B {time.time()-t:.1f} s {url}', flush=True)
    return status, body.decode('utf-8', 'replace')

ids = ['20171211_0000119', '20171211_0000120'] + [f'20171222_00000{n}' for n in (31, 32, 33, 34, 35, 36, 38, 40)]
for eid in ids[:4]:
    for fmt in ('json', 'text', 'xml'):
        get('query', {'format': fmt, 'eventid': eid}, f'event-{eid}.{fmt}')
# A narrow window around two of them, with includeallorigins etc.
get('query', {'format': 'xml', 'starttime': '2017-12-22T08:50:00', 'endtime': '2017-12-22T10:21:00'}, 'window-1222.xml')
get('query', {'format': 'json', 'starttime': '2017-12-22T08:50:00', 'endtime': '2017-12-22T10:21:00'}, 'window-1222.json')
get('count', {'format': 'json', 'starttime': '2017-12-22T08:50:00', 'endtime': '2017-12-22T10:21:00'}, 'window-1222.count')
# Every EMSC month era A still needs: the count against the rows the text format answers.
rows = []
y, m = 2017, 12
while (y, m) >= (2000, 1):
    s = f'{y}-{m:02d}-01T00:00:00'
    ny, nm = (y, m + 1) if m < 12 else (y + 1, 1)
    e = f'{ny}-{nm:02d}-01T00:00:00'
    _, c = get('count', {'format': 'json', 'starttime': s, 'endtime': e}, quiet=True)
    try: n = json.loads(c)['count']
    except Exception: n = None
    st, t = get('query', {'format': 'text', 'limit': '20000', 'starttime': s, 'endtime': e}, quiet=True)
    r = sum(1 for l in t.splitlines() if l and not l.startswith('#'))
    line = f'{y}-{m:02d} count={n} text_rows={r} http={st} diff={None if n is None else n - r}'
    print(line, flush=True)
    rows.append(line)
    y, m = (y, m - 1) if m > 1 else (y - 1, 12)
open(os.path.join(OUT, 'months.txt'), 'w').write('\n'.join(rows) + '\n')
