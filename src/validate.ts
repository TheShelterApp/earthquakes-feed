import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { DATA_DIR, DOMAIN, MAX_PUBLISHED_BYTES, PUBLIC_DIR, SCHEMA_DIR, dataPaths } from './config.js';
import { deltaBoundViolations, readSilentLog } from './live-sync.js';
import { loadPartitionFormat, partitionFormatProblems } from './partitions.js';
import { STATS_INDEX_PATH, checkStats, loadStatsConfig } from './stats.js';
import { FEED_ID_RE } from './stats-table.js';
import { feedIdTimeMs } from './ulid.js';
import { hourKey } from './event-detail.js';
import { APP_STORE_ID, PAGE_CSS, PAGE_CSS_HASH, SHARE_CSP, SHARE_DIR, SHARE_NOT_FOUND, SHARE_PAGE_CAP, eventUrl } from './share-pages.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const compile = (name: string): ValidateFunction =>
  ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8')) as object);

const vObs = compile('observation.schema.json');
const vFeat = compile('feature.schema.json');
const vManifest = compile('manifest.schema.json');
const vLiveIndex = compile('live-index.schema.json');
const vLiveMonth = compile('live-month.schema.json');

/** Cloudflare Pages, Free plan: files per site (deploy) and bytes per file. */
const PAGES_MAX_FILES = 20_000;
const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;

let errors = 0;
const fail = (msg: string): void => {
  errors++;
  console.error(`✗ ${msg}`);
};

function walk(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(full)) out.push(full);
  }
  return out;
}

const p = dataPaths(DATA_DIR);
const publicV1 = join(PUBLIC_DIR, 'v1');

// 1. Observation log: schema + seq invariants (strictly increasing per file;
//    global max of the two most recent files must equal head.seq — M4).
const logFiles = walk(p.observationsDir, (f) => f.endsWith('.ndjson')).sort();
let globalMaxSeq = 0;
for (const file of logFiles) {
  let prevSeq = -1;
  for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as { seq?: number };
    if (!vObs(obj)) fail(`${file}:${i + 1} observation: ${ajv.errorsText(vObs.errors)}`);
    const seq = obj.seq ?? -1;
    if (seq <= prevSeq) fail(`${file}:${i + 1} seq not strictly increasing (${prevSeq} -> ${seq})`);
    prevSeq = seq;
    if (seq > globalMaxSeq) globalMaxSeq = seq;
  }
}
try {
  const head = JSON.parse(readFileSync(p.head, 'utf8')) as { seq: number };
  if (logFiles.length && head.seq !== globalMaxSeq) fail(`head.seq=${head.seq} != log max seq=${globalMaxSeq}`);
} catch {
  if (logFiles.length) fail('head.json missing/unreadable while log exists');
}

// 2. Published summaries (Pages artifact): schema + size gate + no future events.
//    /v1/events/ day files are the documented FULL-detail Pages surface (the compact
//    summaries point consumers there) — every LIVE feature must keep a non-empty
//    feed.provenance[]. A retired feature (superseded or tombstoned) rides along compact and
//    flagged non-live for RETIRED_VISIBLE_MS by contract, so it is exempt.
const nowMs = Date.now();
// The per-hour detail files' feature ids and `moved` members, checked across files after the pass (2b).
const detailIds = new Map<string, Set<string>>();
const detailMoved = new Map<string, Record<string, unknown>>();
for (const file of walk(publicV1, (f) => f.endsWith('.geojson'))) {
  const bytes = statSync(file).size;
  // The hard gate stays the invariant — derive's own budget guard is a producer-side courtesy,
  // this is the backstop. Warn at 75% too: on 2026-07-14 the month files crossed the cap with
  // no prior signal and 51 consecutive derive runs failed for ~4h before anyone noticed.
  if (bytes > MAX_PUBLISHED_BYTES) fail(`${file}: ${bytes} bytes exceeds ${MAX_PUBLISHED_BYTES}`);
  else if (bytes > MAX_PUBLISHED_BYTES * 0.75) {
    console.warn(`::warning::${file}: ${bytes} bytes — ${((bytes / MAX_PUBLISHED_BYTES) * 100).toFixed(1)}% of the ${MAX_PUBLISHED_BYTES}-byte budget`);
  }
  const fc = JSON.parse(readFileSync(file, 'utf8')) as {
    metadata?: { generated?: unknown };
    features?: { id?: string; properties?: { time?: number; feed?: { state?: string; provenance?: unknown[] } } }[];
    moved?: unknown;
  };
  if (typeof fc.metadata?.generated !== 'number') fail(`${file}: metadata.generated must be ms-epoch int`);
  const detailHour = /[/\\]detail[/\\](\d{4}-\d{2}-\d{2}T\d{2})\.geojson$/.exec(file)?.[1];
  if (detailHour) {
    detailIds.set(detailHour, new Set((fc.features ?? []).map((f) => String(f.id))));
    if (fc.moved !== undefined) {
      if (fc.moved === null || typeof fc.moved !== 'object' || Array.isArray(fc.moved)) fail(`${file}: moved is not an object`);
      else detailMoved.set(detailHour, fc.moved as Record<string, unknown>);
    }
  }
  // The per-hour detail files (EVT-5) are full-fat like the day files, live events only.
  const isDayFile = file.includes(join(publicV1, 'events')) || file.includes(join(publicV1, 'detail'));
  for (const [i, feat] of (fc.features ?? []).entries()) {
    if (i < 200 && !vFeat(feat)) {
      fail(`${file}: feature ${ajv.errorsText(vFeat.errors)}`);
      break;
    }
    if (isDayFile) {
      const prov = feat.properties?.feed?.provenance;
      const state = feat.properties?.feed?.state;
      const retired = state === 'superseded' || state === 'tombstoned';
      if (!retired && (!Array.isArray(prov) || prov.length === 0)) {
        fail(`${file}: feature ${i} lost feed.provenance[] — day files must stay full-fat`);
        break;
      }
    } else if (i >= 200) break;
    const t = feat.properties?.time;
    if (typeof t === 'number' && t > nowMs + 15 * 60_000) fail(`${file}: future-timestamped event (time=${t})`);
  }
}

// 2b. The detail files' `moved` members (event-detail.ts, share links): each key is a feed id whose ULID hour is the
//     file's hour and which is not among the file's features; `to` is a feature of the hour file `hour` names.
{
  let problems = 0;
  for (const [hour, moved] of detailMoved) {
    for (const [id, entry] of Object.entries(moved)) {
      const e = entry as { to?: unknown; hour?: unknown } | null;
      const minted = feedIdTimeMs(id);
      const why =
        minted == null ? 'is not a feed id'
        : hourKey(minted) !== hour ? `has its ULID hour ${hourKey(minted)}`
        : detailIds.get(hour)!.has(id) ? 'is a feature of the same file'
        : e == null || typeof e !== 'object' || typeof e.to !== 'string' || !FEED_ID_RE.test(e.to) || typeof e.hour !== 'string' ? 'has no {to, hour}'
        : !detailIds.has(e.hour) ? `points at the hour ${e.hour}, which has no file`
        : !detailIds.get(e.hour)!.has(e.to) ? `points at ${e.to}, which is not in the hour ${e.hour}`
        : null;
      if (why && problems++ < 5) fail(`detail ${hour}: moved ${id} ${why}`);
    }
  }
  if (problems > 5) fail(`detail: ${problems} moved entries break the contract in all`);
}

// 2c. The share pages (share-pages.ts, APIs.md Share pages): the generic page exists, every page is named by a feed id,
//     at most SHARE_PAGE_CAP, no script, its canonical link names a feed id on the site, its only stylesheet is the one
//     whose hash the CSP names, and `_headers` serves /share/* with that CSP. The generic page shows no id and no date.
const shareDir = join(PUBLIC_DIR, SHARE_DIR);
const sharePages = walk(shareDir, (f) => f.endsWith('.html') && !f.endsWith(`${sep}${SHARE_NOT_FOUND}`));
if (existsSync(shareDir)) {
  if (sharePages.length > SHARE_PAGE_CAP) fail(`share: ${sharePages.length} pages, over the cap of ${SHARE_PAGE_CAP}`);
  const styleOf = (html: string): string[] => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
  const shareProblem = (file: string, html: string, page: boolean): string | null => {
    if (/<script/i.test(html)) return 'holds a script';
    if (/\sstyle=/i.test(html)) return 'holds a style attribute (the CSP allows the one stylesheet only)';
    const styles = styleOf(html);
    if (styles.length !== 1 || styles[0] !== PAGE_CSS) return 'does not embed exactly the stylesheet the CSP hashes';
    if (!page) {
      if (/efd_/.test(html)) return 'names a feed id';
      if (/\b(19|20)\d\d\b/.test(html.replace(/https?:\/\/[^"\s]*/g, ''))) return 'shows a year';
      return null;
    }
    const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];
    const id = canonical?.slice(eventUrl('').length);
    if (!canonical || !id || canonical !== eventUrl(id) || !FEED_ID_RE.test(id)) return `has no canonical ${eventUrl('<feed id>')} (got ${canonical ?? 'none'})`;
    if (!html.includes(`content="app-id=${APP_STORE_ID}, app-argument=${canonical}"`)) return 'has no Smart App Banner for its canonical URL';
    return null;
  };
  let problems = 0;
  for (const file of sharePages) {
    const name = file.slice(shareDir.length + 1);
    const why = !FEED_ID_RE.test(name.replace(/\.html$/, '')) ? 'is not named by a feed id' : shareProblem(file, readFileSync(file, 'utf8'), true);
    if (why && problems++ < 5) fail(`share: ${name} ${why}`);
  }
  if (problems > 5) fail(`share: ${problems} pages break the contract in all`);
  const notFound = join(shareDir, SHARE_NOT_FOUND);
  if (!existsSync(notFound)) fail(`share: ${SHARE_DIR}/${SHARE_NOT_FOUND} is missing (an unknown id would get no page)`);
  else {
    const why = shareProblem(notFound, readFileSync(notFound, 'utf8'), false);
    if (why) fail(`share: ${SHARE_NOT_FOUND} ${why}`);
  }
  const headers = existsSync(join(PUBLIC_DIR, '_headers')) ? readFileSync(join(PUBLIC_DIR, '_headers'), 'utf8') : '';
  const rule = /^\/share\/\*\n((?: {2}.*\n?)*)/m.exec(headers)?.[1] ?? '';
  if (!rule.includes(`  Content-Security-Policy: ${SHARE_CSP}\n`) || !SHARE_CSP.includes(PAGE_CSS_HASH)) fail('share: _headers serves /share/* without the CSP that hashes the stylesheet');
}

// 3. Committed day partitions: plain NDJSON, size gate, first lines parse as Features.
//    Full-fat invariant on EVERY line: partitions are the archival surface, so each
//    feature must carry a non-empty feed.provenance[] (the schema allows its absence only
//    because summaries are compact). Sole exception: a tombstoned event may have an empty
//    provenance — op:tombstone withdraws the deleting provider's row by design, and the
//    original observations stay in the append-only log.
// 3c. (in the same pass) `review_status` follows knowledge/index/partition-format.json (partitions.ts PartitionFormat):
//    a day before `review_status_from` (or every day while there is none) has it nowhere, so a frozen day kept its
//    bytes; a day from it on has it on every live event whose representative row says it (partitionFormatProblems).
const partitionFormat = (() => {
  try {
    return loadPartitionFormat(DATA_DIR);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return null;
  }
})();
for (const file of walk(p.eventsDir, (f) => f.endsWith('.ndjson'))) {
  const bytes = statSync(file).size;
  if (bytes > MAX_PUBLISHED_BYTES) fail(`${file}: ${bytes} bytes exceeds ${MAX_PUBLISHED_BYTES}`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const day = /(\d{4})[/\\](\d{2})[/\\](\d{2})\.ndjson$/.exec(file);
  if (partitionFormat && day) {
    const problems = partitionFormatProblems(`${day[1]}-${day[2]}-${day[3]}`, lines, partitionFormat);
    if (problems.length) fail(`${file}: ${problems.length} line(s) break the partition format: ${problems.slice(0, 3).join('; ')}`);
  }
  for (const [i, line] of lines.entries()) {
    const feat = JSON.parse(line) as { properties?: { feed?: { state?: string; provenance?: unknown[] } } };
    if (i < 3 && !vFeat(feat)) {
      fail(`${file}: partition line ${ajv.errorsText(vFeat.errors)}`);
      break;
    }
    const feed = feat.properties?.feed;
    if (!Array.isArray(feed?.provenance) || (feed.provenance.length === 0 && feed.state !== 'tombstoned')) {
      fail(`${file}:${i + 1} partition feature lost feed.provenance[] (state=${feed?.state}) — partitions must stay full-fat`);
      break;
    }
  }
}

// 3b. The Pages copies of the unfrozen day partitions (round 25, storage option 4 phase 1; partitions.ts
//     writePagesPartition): byte for byte the partition derive wrote to the data checkout (sign-manifest.ts hashes that
//     one for the v2 sha256), and every manifest `url` on Pages names one of them, of an unfrozen day, with its `bytes`.
const pagesEventsDir = join(PUBLIC_DIR, 'events');
const pagesNdjson = walk(pagesEventsDir, (f) => f.endsWith('.ndjson'));
for (const file of pagesNdjson) {
  const rel = relative(PUBLIC_DIR, file).split(sep).join('/');
  const inData = join(DATA_DIR, rel);
  if (!existsSync(inData)) fail(`${file}: no partition ${rel} in the data checkout`);
  else if (!readFileSync(file).equals(readFileSync(inData))) fail(`${file}: differs from the data checkout's ${rel}`);
}
try {
  const m = JSON.parse(readFileSync(join(publicV1, 'manifest.json'), 'utf8')) as {
    partitions?: { date: string; path: string; url?: string; bytes?: number; frozen?: boolean }[];
  };
  let onPages = 0;
  for (const part of m.partitions ?? []) {
    if (!part.url?.startsWith(`https://${DOMAIN}/`)) continue;
    onPages++;
    if (part.url !== `https://${DOMAIN}/${part.path}`) fail(`manifest: partition ${part.date} url ${part.url} is not the Pages copy of ${part.path}`);
    if (part.frozen) fail(`manifest: frozen partition ${part.date} has a Pages url (frozen days stay on jsDelivr @data_commit)`);
    const f = join(PUBLIC_DIR, part.path);
    if (!existsSync(f)) fail(`manifest: partition ${part.date} url ${part.url} names no deployed file`);
    else if (part.bytes != null && statSync(f).size !== part.bytes) fail(`manifest: partition ${part.date} bytes ${part.bytes} != ${statSync(f).size} on Pages`);
  }
  if (onPages !== pagesNdjson.length) fail(`manifest: ${onPages} partition url(s) on Pages, ${pagesNdjson.length} NDJSON file(s) deployed`);
} catch (err) {
  if (existsSync(join(publicV1, 'manifest.json'))) fail(`manifest: unreadable (${err instanceof Error ? err.message : String(err)})`);
}

// 4. The live index (PRB-2, live-sync.ts): every day file and delta it lists exists with the listed bytes and sha256,
//    the days are consecutive, and a delta holds only features above its from_seq (a client applies it on that bound)
//    or silent changes the log names (live-sync.ts: such a feature keeps its older seq).
const liveIndexFile = join(publicV1, 'live', 'index.json');
if (existsSync(liveIndexFile)) {
  const idx = JSON.parse(readFileSync(liveIndexFile, 'utf8')) as {
    head_seq?: number;
    days?: { date: string; path: string; bytes: number; sha256: string; count: number }[];
    deltas?: { name: string; path: string; bytes: number; sha256: string; from_seq: number; head_seq: number; count: number }[];
  };
  const read = (rel: string): string | null => {
    const f = join(PUBLIC_DIR, rel);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  };
  const check = (what: string, rel: string, bytes: number, sha: string): string | null => {
    const body = read(rel);
    if (body == null) {
      fail(`live index: ${what} ${rel} is missing`);
      return null;
    }
    if (Buffer.byteLength(body) !== bytes) fail(`live index: ${what} ${rel} has ${Buffer.byteLength(body)} bytes, the index says ${bytes}`);
    if (createHash('sha256').update(body).digest('hex') !== sha) fail(`live index: ${what} ${rel} sha256 differs from the index`);
    return body;
  };
  const silentLog = readSilentLog(DATA_DIR);
  if (!vLiveIndex(idx)) fail(`live index: ${ajv.errorsText(vLiveIndex.errors)}`);
  const days = idx.days ?? [];
  if (!days.length) fail('live index: no days');
  for (const [i, d] of days.entries()) {
    if (i > 0 && Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${days[i - 1]!.date}T00:00:00Z`) !== 86_400_000) {
      fail(`live index: days not consecutive at ${d.date}`);
    }
    check('day', d.path, d.bytes, d.sha256);
  }
  for (const d of idx.deltas ?? []) {
    if (d.head_seq !== idx.head_seq || d.from_seq > d.head_seq) fail(`live index: delta ${d.name} seq bounds ${d.from_seq}..${d.head_seq} (head ${idx.head_seq})`);
    const body = check('delta', d.path, d.bytes, d.sha256);
    if (!body) continue;
    const fc = JSON.parse(body) as { features?: { id?: string; properties?: { feed?: { ingest_seq?: number } } }[] };
    // A feature at or below from_seq is a silent change (live-sync.ts) only when the log derive just wrote names it.
    const low = deltaBoundViolations(fc.features ?? [], d.from_seq, silentLog);
    if (low.length) {
      fail(`live index: delta ${d.name} holds ${low.length} feature(s) at or below its from_seq ${d.from_seq} that the silent log does not name (${low.slice(0, 5).join(', ')})`);
    }
    if ((fc.features ?? []).length !== d.count) fail(`live index: delta ${d.name} count ${d.count} != ${(fc.features ?? []).length} features`);
  }
}

// 4b. The month index (PRB-2, round 27, live-month.ts): every day file it lists exists with the listed bytes and
//     sha256, the days are consecutive, end at the run's day minus newest_offset_days, and hold no feature below the floor.
const liveMonthFile = join(publicV1, 'live', 'month.json');
if (existsSync(liveMonthFile)) {
  const idx = JSON.parse(readFileSync(liveMonthFile, 'utf8')) as {
    generated?: number;
    min_mag?: number;
    newest_offset_days?: number;
    count?: number;
    days?: { date: string; path: string; bytes: number; sha256: string; count: number }[];
  };
  if (!vLiveMonth(idx)) fail(`month index: ${ajv.errorsText(vLiveMonth.errors)}`);
  const days = idx.days ?? [];
  const newest = typeof idx.generated === 'number' && typeof idx.newest_offset_days === 'number'
    ? new Date(idx.generated - idx.newest_offset_days * 86_400_000).toISOString().slice(0, 10)
    : null;
  if (newest && days.at(-1)?.date !== newest) fail(`month index: the newest day is ${days.at(-1)?.date}, not ${newest}`);
  let live = 0;
  for (const [i, d] of days.entries()) {
    if (i > 0 && Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${days[i - 1]!.date}T00:00:00Z`) !== 86_400_000) {
      fail(`month index: days not consecutive at ${d.date}`);
    }
    const f = join(PUBLIC_DIR, d.path);
    if (!existsSync(f)) {
      fail(`month index: day ${d.path} is missing`);
      continue;
    }
    const body = readFileSync(f, 'utf8');
    if (Buffer.byteLength(body) !== d.bytes) fail(`month index: day ${d.path} has ${Buffer.byteLength(body)} bytes, the index says ${d.bytes}`);
    if (createHash('sha256').update(body).digest('hex') !== d.sha256) fail(`month index: day ${d.path} sha256 differs from the index`);
    const fc = JSON.parse(body) as { features?: { properties?: { mag?: number | null; time?: number; feed?: { state?: string } } }[] };
    const feats = fc.features ?? [];
    const below = feats.filter((x) => !(typeof x.properties?.mag === 'number' && x.properties.mag >= (idx.min_mag ?? 0))).length;
    if (below) fail(`month index: day ${d.path} holds ${below} feature(s) below M ${idx.min_mag}`);
    const off = feats.filter((x) => typeof x.properties?.time !== 'number' || new Date(x.properties.time).toISOString().slice(0, 10) !== d.date).length;
    if (off) fail(`month index: day ${d.path} holds ${off} feature(s) of another day`);
    const dayLive = feats.filter((x) => x.properties?.feed?.state === 'live').length;
    if (dayLive !== d.count) fail(`month index: day ${d.path} count ${d.count} != ${dayLive} live features`);
    live += dayLive;
  }
  if (idx.count !== live) fail(`month index: count ${idx.count} != ${live} live features over its days`);
}

// 4c. The statistics (stats.ts, APIs.md Statistics): derive publishes them only after its own check passed, so a
//     failure here is a bug in that check. Every invariant again (checkStats, for the manifest's run), and the
//     manifest's `stats` pointer names exactly this index. The year and area files lag by design (stats.yml); `through`
//     unset (once the builder is on) or older than the run's day - 20 is a warning.
{
  const statsIndexFile = join(PUBLIC_DIR, STATS_INDEX_PATH);
  type StatsManifest = { generated?: number; stats?: { path?: string; url?: string; head_seq?: number; format?: number } };
  const m = ((): StatsManifest | null => {
    try {
      return JSON.parse(readFileSync(join(publicV1, 'manifest.json'), 'utf8')) as StatsManifest;
    } catch {
      return null;
    }
  })();
  if (existsSync(statsIndexFile)) {
    if (!m || typeof m.generated !== 'number') fail('stats: an index without a readable manifest');
    else {
      for (const e of checkStats(PUBLIC_DIR, m.generated)) fail(`stats: ${e}`);
      const idx = JSON.parse(readFileSync(statsIndexFile, 'utf8')) as { head_seq?: number; format?: number; through?: string | null };
      const p = m.stats;
      if (!p) fail(`stats: ${STATS_INDEX_PATH} is deployed but the manifest has no stats pointer`);
      else if (p.path !== STATS_INDEX_PATH || p.url !== `https://${DOMAIN}/${STATS_INDEX_PATH}` || p.head_seq !== idx.head_seq || p.format !== idx.format) {
        fail(`stats: the manifest's pointer ${JSON.stringify(p)} does not name this index (head_seq ${idx.head_seq}, format ${idx.format})`);
      }
      const floor = new Date(m.generated - 20 * 86_400_000).toISOString().slice(0, 10);
      // Before the builder is switched on (history_enabled) a null `through` is expected: a plain line, not 288 warnings a day.
      if (idx.through == null && loadStatsConfig().config?.history_enabled !== true) console.log('validate: stats through is null (the year and area builder is off)');
      else if (idx.through == null) console.warn('::warning::stats: through is null (the year and area builder has not run): the year view has no year files');
      else if (idx.through < floor) console.warn(`::warning::stats: through ${idx.through} is older than ${floor}: the year and area files lag`);
    }
  } else if (m?.stats) fail(`stats: the manifest points at ${m.stats.path}, which is not deployed`);
}

// 5. Manifest (canonical Pages copy).
try {
  if (!vManifest(JSON.parse(readFileSync(join(publicV1, 'manifest.json'), 'utf8')))) {
    fail(`manifest: ${ajv.errorsText(vManifest.errors)}`);
  }
} catch {
  console.warn('· no public manifest.json yet (run derive first)');
}

// 6. Cloudflare Pages limits (developers.cloudflare.com/pages/platform/limits, Free plan): at most 20,000 files per
//    deploy and 25 MiB per file. A deploy past either fails; warn from 75 % of the file count.
const deployed = walk(PUBLIC_DIR, () => true);
if (deployed.length) {
  if (deployed.length > PAGES_MAX_FILES) fail(`Pages: ${deployed.length} files, over the ${PAGES_MAX_FILES}-file limit`);
  else if (deployed.length > PAGES_MAX_FILES * 0.75) console.warn(`::warning::Pages: ${deployed.length} files, ${((deployed.length / PAGES_MAX_FILES) * 100).toFixed(1)}% of the ${PAGES_MAX_FILES}-file limit`);
  let total = 0;
  for (const f of deployed) {
    const size = statSync(f).size;
    total += size;
    if (size > PAGES_MAX_FILE_BYTES) fail(`Pages: ${f} is ${size} bytes, over the ${PAGES_MAX_FILE_BYTES}-byte file limit`);
  }
  // The share pages grow with a busy month up to their cap: the deploy must have room for all of them.
  const atCap = deployed.length - sharePages.length + SHARE_PAGE_CAP;
  if (atCap > PAGES_MAX_FILES * 0.75) {
    console.warn(`::warning::Pages: ${deployed.length - sharePages.length} files besides the share pages + their cap of ${SHARE_PAGE_CAP} = ${atCap}, ${((atCap / PAGES_MAX_FILES) * 100).toFixed(1)}% of the ${PAGES_MAX_FILES}-file limit`);
  }
  console.log(`validate: Pages deploy ${deployed.length} files (limit ${PAGES_MAX_FILES}; ${sharePages.length} share page(s), cap ${SHARE_PAGE_CAP}), ${(total / 1e6).toFixed(1)} MB, ${pagesNdjson.length} NDJSON partition(s)`);
}

if (errors) {
  console.error(`\nvalidate: FAILED with ${errors} error(s)`);
  process.exit(1);
}
console.log('validate: OK');
