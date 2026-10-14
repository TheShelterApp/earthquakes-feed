import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOT_WINDOW_DAYS, TEMPORAL_MS } from '../src/config.js';
import { parseTmd, tmdEventPageRow } from '../src/custom.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { RECOVER_DEADLINE_MS, RECOVER_MAX_IDS, RECOVER_SPACING_MS, parseRecoverSpec, recoverReports, recoverStatus, recoverSummary, recoveredReason } from '../src/recover.js';
import type { EventNode, Observation, ProviderConfig } from '../src/types.js';

// Round 25: the events TMD listed from 2026-10-09 to 10-13 while the feed could not read its file (#100) are read back
// from the page TMD keeps per event (https://eq.tmd.go.th/EQ<id>) by a hand-dispatched aggregate run (input `recover`).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const tmdCfg = registry.find((p) => p.id === 'tmd')!;
const DAY = 86_400_000;

/** The detail table of https://eq.tmd.go.th/EQ17188 as TMD served it on 2026-10-14 (verbatim; the rest of the page is
 *  the site's frame). */
const PAGE_17188 = [
  '<table width="100%" border="0" class="lineborder border-spacing-2">',
  '<tr><td class="padding-5" colspan="2" bgcolor="#666666"><font style="color:#fff;font-size:12pt"><i class="fa-solid fa-circle-info"></i> รายละเอียดข้อมูลแผ่นดินไหว</font></td></tr>',
  '<tr><td class="padding-5" bgcolor="#999999" width="200" align="right" valign="top"><font color=white><b>บริเวณ (Region)</b></font></td><td class="tbis4 padding-5" valign="top">พรมแดนประเทศเมียนมา - ประเทศจีน<br />Myanmar - China Border Region</td></tr>',
  '<tr><td class="padding-5" bgcolor="#999999" align="right"><font color=white><b>เวลาที่เกิด (Origin Time)</b></font></td><td class="tbis4 padding-5" valign="top">2026-10-10 01:23:35 ตามเวลามาตรฐานสากล UTC<br />2026-10-10 08:23:35 ตามเวลาประเทศไทย TST</td></tr>',
  '<tr><td class="padding-5" bgcolor="#999999" align="right"><font color=white><b>ขนาด (Magnitude)</b></font></td><td class="tbis4 padding-5" valign="top">4.5</td></tr>',
  '<tr><td class="padding-5" bgcolor="#999999" align="right"><font color=white><b>ศูนย์กลาง (Epicenter)</b></font></td><td class="tbis4 padding-5" valign="top">21.807°N , 99.083°E&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;',
  '<a target="_blank" href="http://www.google.com/maps/place/21.807,99.083/@21.807,99.083,7z"><i class="fa-solid fa-map-location-dot"></i> Google Maps</a></td></tr>',
  '<tr><td class="padding-5" bgcolor="#999999" align="right"><font color=white>ความลึก (Depth)</font></td><td class="tbis4 padding-5"> 10 Km.</td></tr>',
  '<tr><td class="padding-5" bgcolor="#999999" align="right"><font color=white><b>* Phase Count</b></font></td><td class="tbis4 padding-5" valign="top">19</td></tr>',
  '</table>',
].join('\n');

/** A page in the same markup (ASCII region names). */
function page(o: { region: string; utc: string; tst: string; mag: string; epi: string; depth: string }): string {
  return [
    `<html><head><title>M ${o.mag}</title></head><body><table>`,
    `<tr><td><font color=white><b>R (Region)</b></font></td><td class="tbis4 padding-5" valign="top">${o.region}<br />English name</td></tr>`,
    `<tr><td><font color=white><b>T (Origin Time)</b></font></td><td class="tbis4 padding-5" valign="top">${o.utc} x UTC<br />${o.tst} x TST</td></tr>`,
    `<tr><td><font color=white><b>M (Magnitude)</b></font></td><td class="tbis4 padding-5" valign="top">${o.mag}</td></tr>`,
    `<tr><td><font color=white><b>E (Epicenter)</b></font></td><td class="tbis4 padding-5" valign="top">${o.epi}&nbsp;&nbsp;\n<a href="#">Google Maps</a></td></tr>`,
    `<tr><td><font color=white>D (Depth)</font></td><td class="tbis4 padding-5"> ${o.depth} Km.</td></tr>`,
    '</table></body></html>',
  ].join('\n');
}
/** What TMD answers for an id it does not hold: HTTP 200 and its "404 Page Not Found" page (EQ17300, 2026-10-14). */
const NOT_FOUND = '<!DOCTYPE html><html><head><title>404 Page Not Found</title></head><body><h1>404 Page Not Found</h1></body></html>';

test('tmd event page: read back into the map-events.json row it stands for, and parsed by the adapter', () => {
  const row = tmdEventPageRow(PAGE_17188, '17188');
  // The row map-events.json listed for 17188 had these values (and `timeth`, which the page writes another way).
  assert.deepEqual(row, {
    eventID: '17188', otime: '2026-10-10 01:23:35', lat: 21.807, lon: 99.083, depth: 10, mag: 4.5,
    region: 'พรมแดนประเทศเมียนมา - ประเทศจีน', path: 'EQ17188',
  });
  const [r] = parseTmd({ events: [row] }, 'tmd');
  assert.equal(r!.providerEventId, '17188');
  assert.equal(r!.eventTimeMs, Date.parse('2026-10-10T01:23:35Z'));
  assert.deepEqual([r!.lat, r!.lon, r!.depth, r!.mag, r!.place], [21.807, 99.083, 10, 4.5, 'พรมแดนประเทศเมียนมา - ประเทศจีน']);
});

test('tmd event page: south and west, a missing magnitude, and pages that hold no event', () => {
  const base = { region: 'Sumatra', utc: '2026-10-09 11:32:00', tst: '2026-10-09 18:32:00', mag: '3.9', epi: '3.250°S , 101.5°W', depth: '33' };
  const south = tmdEventPageRow(page(base), '1')!;
  assert.deepEqual([south['lat'], south['lon'], south['depth'], south['region']], [-3.25, -101.5, 33, 'Sumatra']);
  assert.equal(tmdEventPageRow(page({ ...base, mag: '-' }), '1')!['mag'], null, 'no magnitude: the report keeps its place and time');
  assert.equal(tmdEventPageRow(page({ ...base, tst: '2026-10-09 18:33:00' }), '1'), null, 'UTC and Thai times disagree');
  assert.equal(tmdEventPageRow(page({ ...base, epi: 'n/a' }), '1'), null, 'no epicentre');
  assert.equal(tmdEventPageRow(NOT_FOUND, '17300'), null);
});

test('recover spec: ids and ranges of one provider with a page reader, at most RECOVER_MAX_IDS', () => {
  assert.deepEqual(parseRecoverSpec(' tmd:17182-17184 '), { provider: 'tmd', ids: ['17182', '17183', '17184'] });
  assert.deepEqual(parseRecoverSpec('tmd:17190,17182-17183,17190'), { provider: 'tmd', ids: ['17182', '17183', '17190'] });
  assert.throws(() => parseRecoverSpec('tmd:17184-17182'), /backwards/);
  assert.throws(() => parseRecoverSpec(`tmd:1-${RECOVER_MAX_IDS + 1}`), /more than/);
  assert.throws(() => parseRecoverSpec('emsc:1-2'), /no page reader/);
  for (const bad of ['tmd', 'tmd:', 'tmd:17182;rm -rf', 'tmd:EQ17182', 'TMD:1', 'tmd:1-2-3']) assert.throws(() => parseRecoverSpec(bad), /is not|no page reader/, bad);
});

test('recover spec: ids of at most 9 digits, and an error message of one bounded line (round 25 review)', () => {
  assert.deepEqual(parseRecoverSpec('tmd:123456789').ids, ['123456789']);
  // A 10-digit id is refused. Without the bound, an id above 2^53 never ended the expansion loop (i++ leaves it
  // unchanged): the aggregate step spun until its timeout. The 10-digit case runs first, so the unfixed code fails
  // here instead of hanging the test.
  assert.throws(() => parseRecoverSpec('tmd:1234567890'), /is not/);
  for (const big of ['tmd:9007199254740993', 'tmd:99999999999999999999', 'tmd:17182-99999999999999999999']) {
    assert.throws(() => parseRecoverSpec(big), /is not/, big);
  }
  // The message goes into a ::warning workflow command: a newline in the input must not start another command.
  for (const bad of ['tmd:1\n::error::forged', `tmd:${'x'.repeat(500)}`]) {
    const err = (() => {
      try {
        parseRecoverSpec(bad);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    assert.match(err, /is not/);
    assert.ok(!/[\r\n]/.test(err), 'one line');
    assert.ok(err.length < 200, `bounded: ${err.length}`);
  }
  // Many parts stop as soon as the count passes the cap.
  assert.throws(() => parseRecoverSpec(`tmd:${Array.from({ length: 2 * RECOVER_MAX_IDS }, (_, i) => 17000 + i).join(',')}`), /more than/);
});

/** A fake clock: sleep moves it, each fetch takes `latencyMs`. */
function clock(latencyMs = 300): { now: () => number; sleep: (ms: number) => Promise<void>; tick: (ms: number) => void } {
  let t = Date.parse('2026-10-14T05:00:00Z');
  return { now: () => t, sleep: async (ms) => void (t += ms), tick: (ms) => void (t += ms) };
}
const NOW = Date.parse('2026-10-14T05:00:00Z');
const HOT_FLOOR = NOW - HOT_WINDOW_DAYS * DAY;
const pageFor = (id: string, utc = '2026-10-10 06:29:00', tst = '2026-10-10 13:29:00'): string =>
  page({ region: `r${id}`, utc, tst, mag: '2.2', epi: '19.540°N , 98.386°E', depth: '3' });

test('recover: one request at a time, at least RECOVER_SPACING_MS apart, one spaced retry, the URL the file names', async () => {
  const c = clock();
  const starts: { url: string; at: number }[] = [];
  let failOnce = true;
  const out = await recoverReports('tmd:17189-17191', [tmdCfg], new Map(), HOT_FLOOR, {
    now: c.now,
    sleep: c.sleep,
    fetchPage: async (url) => {
      starts.push({ url, at: c.now() });
      c.tick(300);
      if (url.endsWith('17190') && failOnce) {
        failOnce = false;
        throw new Error('socket hang up');
      }
      return url.endsWith('17191') ? NOT_FOUND : pageFor(url.slice(-5));
    },
  });
  assert.deepEqual(starts.map((s) => s.url), [
    'https://eq.tmd.go.th/EQ17189', 'https://eq.tmd.go.th/EQ17190', 'https://eq.tmd.go.th/EQ17190', 'https://eq.tmd.go.th/EQ17191',
  ]);
  assert.ok(starts[0]!.at - NOW >= RECOVER_SPACING_MS, 'the first page waits one spacing after the live fetch of the host');
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]!.at - starts[i - 1]!.at >= RECOVER_SPACING_MS, `request ${i} too soon`);
  assert.deepEqual(out.rows.map((r) => r.providerEventId), ['17189', '17190']);
  assert.deepEqual(out.empty, ['17191']);
  assert.deepEqual([out.asked, out.failed, out.unasked, out.error], [3, [], [], undefined]);
  assert.equal(recoverSummary(out), 'recover tmd: asked=3 rows=2 empty=[17191]');
  assert.equal(out.pages.get(out.rows[0]!), 'https://eq.tmd.go.th/EQ17189', 'each report keeps the page it came from (its log line names it)');
  assert.deepEqual(recoverStatus(out), { provider: 'tmd', asked: 3, rows: ['17189', '17190'], empty: ['17191'], held_as: [], outside_window: [], failed: [], unasked: [] });
  assert.equal(
    recoveredReason('https://eq.tmd.go.th/EQ17189', 3.96),
    "recovered from the provider's event page https://eq.tmd.go.th/EQ17189, 4.0 d after origin (no longer in its rolling file)",
  );
});

test('recover: a page failing twice is listed and the run goes on; past the deadline nothing more is asked', async () => {
  const c = clock();
  let calls = 0;
  const out = await recoverReports(`tmd:1-${RECOVER_MAX_IDS}`, [tmdCfg], new Map(), HOT_FLOOR, {
    now: c.now,
    sleep: c.sleep,
    fetchPage: async (url) => {
      calls++;
      c.tick(4_000); // a slow host: about 5 s per page with the spacing
      if (url.endsWith('EQ2')) throw new Error('HTTP 500');
      return pageFor('x');
    },
  });
  assert.deepEqual(out.failed, ['2: HTTP 500']);
  assert.ok(out.unasked.length > 0 && out.unasked.length < RECOVER_MAX_IDS);
  assert.equal(out.rows.length + out.failed.length + out.unasked.length, RECOVER_MAX_IDS);
  assert.equal(calls, out.rows.length + 2, 'one retry for the failing page, none past the deadline');
  assert.ok(c.now() - NOW <= RECOVER_DEADLINE_MS + 4_000 + RECOVER_SPACING_MS);
});

test('recover: a report the feed holds under its origin-second name, one older than the hot window, a bad spec, an inactive source', async () => {
  const held: EventNode = {
    feedId: 'efd_held', aliases: ['tmd:t20261008074512'], eventTimeMs: Date.parse('2026-10-08T07:45:12Z'), firstIngestTime: '', lastIngestTime: '',
    lat: 5.637, lon: 94.885, depth: 10, mag: 4.1, magType: null, status: null, place: null, chosenProvider: 'tmd',
    provenance: [{ provider: 'tmd', nativeId: 't20261008074512', eventTimeMs: Date.parse('2026-10-08T07:45:12Z'), mag: 4.1, magType: null, status: null, providerUpdatedMs: null, lat: 5.637, lon: 94.885, depth: 10, place: null, chosen: true, license: 'unknown', attribution: 'TMD', doi: null, fields: {} }],
    revision: 1, firstSeenSeq: 1, lastSeq: 1, state: 'live', geohash: 'x',
  };
  const c = clock();
  const pages: Record<string, string> = {
    '17181': pageFor('17181', '2026-10-08 07:45:12', '2026-10-08 14:45:12'),
    '17150': pageFor('17150', '2026-10-01 00:00:00', '2026-10-01 07:00:00'),
    '17182': pageFor('17182', new Date(HOT_FLOOR + TEMPORAL_MS - 1000).toISOString().slice(0, 19).replace('T', ' '), new Date(HOT_FLOOR + TEMPORAL_MS - 1000 + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')),
  };
  const deps = { now: c.now, sleep: c.sleep, fetchPage: async (url: string) => pages[url.slice(-5)]! };
  const out = await recoverReports('tmd:17150,17181,17182', [tmdCfg], new Map([['efd_held', held]]), HOT_FLOOR, deps);
  assert.deepEqual(out.held_as, ['17181=t20261008074512'], 'its numeric id would be another TMD quake to the Resolver');
  assert.deepEqual(out.outside_window.map((s) => s.split('@')[0]), ['17150', '17182'], 'the floor keeps one identity window of margin');
  assert.equal(out.rows.length, 0);

  const bad = await recoverReports('tmd:x', [tmdCfg], new Map(), HOT_FLOOR, deps);
  assert.match(bad.error!, /is not/);
  const inactive = await recoverReports('tmd:1', [{ ...tmdCfg, id: 'other' } as ProviderConfig], new Map(), HOT_FLOOR, deps);
  assert.match(inactive.error!, /not an active source/);
  assert.match(recoverSummary(inactive), /error=recover: tmd is not an active source/);
});

test('recover → Resolver: a page joins the EMSC copy of it and the CENC + EMSC event in TMD\'s window, a TMD-only one mints; again = no change', async () => {
  // The log lines of the two events production held on 2026-10-14 (EMSC's copy of TMD's 17183, CENC's and EMSC's
  // solutions of the M4.5 TMD numbered 17188, 26 km and 3 s away).
  const lines = readFileSync(here('fixtures/tmd-recover-partners-2026-10.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Observation);
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), NOW);
  for (const o of lines) r.ingest(observationToRaw(o), o.ingest_time);
  const before = map.size;
  const pages: Record<string, string> = {
    '17183': page({ region: 'Near South Coast', utc: '2026-10-09 16:23:04', tst: '2026-10-09 23:23:04', mag: '3.4', epi: '16.092°N , 96.327°E', depth: '10' }),
    '17188': PAGE_17188,
    '17190': page({ region: 'Pai', utc: '2026-10-10 06:29:00', tst: '2026-10-10 13:29:00', mag: '2.2', epi: '19.540°N , 98.386°E', depth: '3' }),
  };
  const c = clock();
  const out = await recoverReports('tmd:17183,17188,17190', [tmdCfg], map, HOT_FLOOR, { now: c.now, sleep: c.sleep, fetchPage: async (url) => pages[url.slice(-5)]! });
  assert.equal(out.rows.length, 3);
  const results = out.rows.map((raw) => r.ingest(raw, '2026-10-14T05:00:00.000Z'));
  const providers = (n: EventNode): string => [...new Set(n.provenance.map((p) => p.provider))].sort().join('+');
  assert.deepEqual(results.map((x) => [x.changed, providers(x.node)]), [[true, 'emsc+tmd'], [true, 'cenc+emsc+tmd'], [true, 'tmd']]);
  assert.equal(map.size, before + 1, 'one new event');
  // Rows in two live events: none.
  const seen = new Map<string, number>();
  for (const n of map.values()) if (n.state === 'live') for (const p of n.provenance) seen.set(`${p.provider}:${p.nativeId}`, (seen.get(`${p.provider}:${p.nativeId}`) ?? 0) + 1);
  assert.deepEqual([...seen.values()].filter((v) => v > 1), []);
  // A second run with the same input: unchanged re-reports, nothing to log.
  assert.deepEqual(out.rows.map((raw) => r.ingest(raw, '2026-10-14T05:05:00.000Z').changed), [false, false, false]);
});

test('aggregate.yml: the recover input is optional (the heartbeat dispatches without inputs) and reaches the step only through the environment', () => {
  const yml = readFileSync(here('../.github/workflows/aggregate.yml'), 'utf8');
  const input = yml.match(/\n {6}recover:\n([\s\S]*?)\n\n/)?.[1] ?? '';
  assert.match(input, /required: false/);
  assert.match(input, /default: ''/);
  assert.match(yml, /\n {10}FEED_RECOVER: \$\{\{ inputs\.recover \}\}\n {8}run: npx --no-install tsx src\/aggregate\.ts\n/);
  assert.equal((yml.match(/inputs\.recover/g) ?? []).length, 1, 'never interpolated into a script');
});
