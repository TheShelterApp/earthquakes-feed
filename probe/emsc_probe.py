"""Temporary probe (round 23): what EMSC answers for 2017-12, the month deep history cannot read. At most one request
every 2 s to seismicportal.eu. Writes everything to probe-out/."""
import json, os, re, time, urllib.request, urllib.parse, urllib.error

UA = 'earthquakes-feed-history/1.0 (+https://github.com/TheShelterApp/earthquakes-feed; deep-history backfill, one request at a time)'
BASE = 'https://www.seismicportal.eu/fdsnws/event/1/'
OUT = 'probe-out'
os.makedirs(OUT, exist_ok=True)
last = [0.0]
log = []

def get(path, params, name):
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
    open(os.path.join(OUT, name), 'wb').write(body)
    line = f'{name}: HTTP {status} {len(body)} B {time.time()-t:.1f} s {url}'
    print(line, flush=True); log.append(line)
    return status, body.decode('utf-8', 'replace')

def T(s): return s

M = {'starttime': '2017-12-01T00:00:00', 'endtime': '2018-01-01T00:00:00'}
get('count', {'format': 'json', **M}, 'count-month.json')
st, body = get('query', {'format': 'json', 'limit': '20000', **M}, 'query-month.json')
defects = [m.start() for m in re.finditer(r',\s*,', body)]
print('double commas at', defects[:50], 'total', len(defects))
ctx = []
for d in defects[:20]:
    ctx.append(body[max(0, d - 1500): d + 1500])
open(os.path.join(OUT, 'defect-context.txt'), 'w').write('\n=====\n'.join(ctx))
# Other oddities: any other JSON error after removing empty elements?
fixed = re.sub(r'(?<=\})\s*,(\s*,)+', ',', body)
try:
    j = json.loads(fixed)
    feats = j.get('features', [])
    print('features after dropping empty elements', len(feats))
except Exception as e:
    print('still unreadable after dropping empty elements:', e)
    feats = []
# The ids around each defect.
times = []
for d in defects[:20]:
    before = body[max(0, d - 4000): d]
    after = body[d: d + 4000]
    ib = re.findall(r'"unid"\s*:\s*"([^"]+)"', before)
    tb = re.findall(r'"time"\s*:\s*"([^"]+)"', before)
    ia = re.findall(r'"unid"\s*:\s*"([^"]+)"', after)
    ta = re.findall(r'"time"\s*:\s*"([^"]+)"', after)
    print('defect', d, 'before', ib[-1:] , tb[-1:], 'after', ia[:1], ta[:1])
    if tb: times.append(tb[-1])
    if ta: times.append(ta[0])
st, text = get('query', {'format': 'text', 'limit': '20000', **M}, 'query-month.txt')
tids = [l.split('|')[0] for l in text.splitlines() if l and not l.startswith('#')]
print('text rows', len(tids))
jids = set(str(f.get('id') or f.get('properties', {}).get('unid')) for f in feats)
missing = [i for i in tids if i not in jids]
print('in text, not in json:', len(missing), missing[:20])
extra = [i for i in jids if i not in set(tids)]
print('in json, not in text:', len(extra), extra[:20])
for i, eid in enumerate(missing[:5]):
    get('query', {'format': 'json', 'eventid': eid}, f'event-{i}.json')
    get('query', {'format': 'text', 'eventid': eid}, f'event-{i}.txt')
    get('query', {'format': 'xml', 'eventid': eid}, f'event-{i}.xml')
days = sorted(set(t[:10] for t in times))[:3]
for k, day in enumerate(days):
    D = {'starttime': f'{day}T00:00:00', 'endtime': f'{day}T23:59:59'}
    get('count', {'format': 'json', **D}, f'count-day{k}.json')
    st, b = get('query', {'format': 'json', 'limit': '20000', **D}, f'query-day{k}.json')
    print(day, 'double commas', len(re.findall(r',\s*,', b)))
open(os.path.join(OUT, 'log.txt'), 'w').write('\n'.join(log) + '\n')
