/**
 * Dry run of the one-time heal (config HEAL_EPOCH, src/heal.ts) against a checkout of the data
 * branch: loads the event_map exactly as the heal run of aggregate does, runs the coordinate-less
 * retraction and Resolver.heal in memory, and reports what they would do. Writes nothing to the
 * data directory.
 *
 * Usage:
 *   npx tsx scripts/heal-dryrun.ts --data <data-branch dir> [--now <iso>] [--out <report.md>]
 *
 * <data-branch dir> needs knowledge/index (event_map shards + head.json), e.g.
 *   git archive origin/data knowledge/index | tar -x -C /tmp/data
 * --now defaults to head.ingest_time + 5 min (the next aggregate run).
 *
 * The report lists every group the heal folds (each member's providers, solution, distance and
 * Δt to the survivor, the op:merge reason) with sanity flags for a false merge, the coordinate-
 * less retraction, the lines it would append (validated against observation.schema.json), and
 * every live M ≥ 5.5 pair within 50 km / 60 s that stays split, with the gate that keeps it so.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadState } from '../src/bitemporal.js';
import { EVENT_MAP_HORIZON_DAYS, HEAL_EPOCH, HOT_WINDOW_DAYS, LIVE_INDEX_DAYS } from '../src/config.js';
import { REHOMED_REASON_PREFIX, Resolver } from '../src/dedup.js';
import { runFeedSideSteps } from '../src/heal.js';
import { haversineKm } from '../src/geo.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation } from '../src/types.js';
import { isoFromMs, statusRank } from '../src/util.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = opt('--data');
if (!dataDir) {
  console.error('usage: heal-dryrun --data <data-branch dir> [--now <iso>] [--out <report.md>]');
  process.exit(2);
}
const outPath = opt('--out');
const head = JSON.parse(readFileSync(resolve(dataDir, 'knowledge/index/head.json'), 'utf8')) as { seq: number; ingest_time: string };
const nowMs = opt('--now') ? Date.parse(opt('--now')!) : Date.parse(head.ingest_time) + 5 * 60_000;
const ingestTime = isoFromMs(nowMs);
const loadDays = Math.max(LIVE_INDEX_DAYS, EVENT_MAP_HORIZON_DAYS);

const registry = loadRegistry(resolve(new URL('../providers/registry.json', import.meta.url).pathname));
const state = loadState(dataDir, { sinceDays: loadDays, nowMs });
const before = new Map<string, EventNode>();
for (const [k, n] of state.eventMap) before.set(k, JSON.parse(JSON.stringify(n)) as EventNode);

// The production step itself (aggregate → runFeedSideSteps), with its marker sent to a scratch
// directory; merges and retractions are read back from the lines it logged.
const resolver = new Resolver(state.eventMap, priorityMap(registry), configMap(registry), nowMs);
const log = new LogBuffer(head.seq, ingestTime);
const scratch = mkdtempSync(join(tmpdir(), 'heal-dryrun-'));
const side = runFeedSideSteps(scratch, resolver, log, { healDue: true, loadDays, ingestTime });
rmSync(scratch, { recursive: true, force: true });
// op:tombstone lines are the retraction's, or a re-homed EMSC copy's withdrawal (FEED-2, with its own reason).
const isRehome = (l: Observation): boolean => l.op === 'tombstone' && (l.reason ?? '').startsWith(REHOMED_REASON_PREFIX);
const rehomes = log.lines.filter(isRehome);
const afterRetraction = log.lines.filter((l) => l.op === 'tombstone' && !isRehome(l)).length;
const retractions = log.lines
  .filter((l) => l.op === 'tombstone' && !isRehome(l))
  .map((l) => ({ raw: { provider: l.provider, eventTimeMs: Date.parse(l.event_time), mag: l.mag, depth: l.depth }, result: { node: state.eventMap.get(l.feed_id)! } }));
const merges = log.lines
  .filter((l) => l.op === 'merge')
  .map((l) => ({ loser: state.eventMap.get(l.feed_id)!, survivor: state.eventMap.get(l.superseded_by!)!, reason: l.reason ?? '' }));
if (side.heal?.merged !== merges.length || side.retracted !== retractions.length || side.rehomed !== rehomes.length) throw new Error('dry run: the logged lines disagree with the step result');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(new URL('../schema/observation.schema.json', import.meta.url), 'utf8')) as object);
const invalid: Observation[] = log.lines.filter((l) => !vObs(l as object));
const seqs = log.lines.map((l) => l.seq);
const seqOk = seqs.every((s, i) => s === head.seq + 1 + i);

const fmt = (n: number, d = 1): string => n.toFixed(d);
const providersOf = (n: EventNode): string[] => [...new Set(n.provenance.map((r) => r.provider))].sort();
const md: string[] = [];
const hotFloor = nowMs - HOT_WINDOW_DAYS * 86_400_000;
const liveBefore = [...before.values()].filter((n) => n.state === 'live');
md.push(`# Heal dry run (epoch ${HEAL_EPOCH})`);
md.push('');
md.push(`Data: head seq ${head.seq} @ ${head.ingest_time}; simulated run at ${ingestTime}; event_map days loaded: ${loadDays} (${before.size} nodes, ${liveBefore.length} live); hot window from ${isoFromMs(hotFloor)} (${liveBefore.filter((n) => n.eventTimeMs >= hotFloor).length} live nodes).`);
md.push('');
md.push(`| lines | op:tombstone (retraction) | op:merge | op:correction | schema-invalid | seq contiguous from ${head.seq + 1} |`);
md.push('|---|---|---|---|---|---|');
md.push(`| ${log.lines.length} | ${afterRetraction} | ${log.lines.filter((l) => l.op === 'merge').length} | ${log.lines.filter((l) => l.op === 'correction').length} | ${invalid.length} | ${seqOk ? 'yes' : 'NO'} |`);
md.push('');

// --- retraction ---
const retractedNodes = new Set(retractions.map((r) => r.result.node.feedId));
const byProv = new Map<string, number>();
const byDay = new Map<string, number>();
for (const { raw } of retractions) {
  byProv.set(raw.provider, (byProv.get(raw.provider) ?? 0) + 1);
  const d = isoFromMs(raw.eventTimeMs).slice(0, 10);
  byDay.set(d, (byDay.get(d) ?? 0) + 1);
}
const stillLive = retractions.filter((r) => r.result.node.state === 'live').length;
md.push(`## Coordinate-less retraction (${retractions.length} rows, ${retractedNodes.size} nodes)`);
md.push('');
md.push(`By provider: ${[...byProv].map(([p, n]) => `${p} ${n}`).join(', ') || 'none'}. Nodes left live with other rows: ${stillLive}. Magnitudes: ${[...new Set(retractions.map((r) => String(r.raw.mag)))].join(', ') || 'n/a'}; depths: ${[...new Set(retractions.map((r) => String(r.raw.depth)))].join(', ') || 'n/a'}.`);
md.push('');
md.push(`By event day: ${[...byDay].sort().map(([d, n]) => `${d.slice(5)} ${n}`).join(', ') || 'none'}.`);
md.push('');

// --- EMSC copies re-homed (FEED-2) ---
md.push(`## EMSC copies re-homed (${rehomes.length})`);
md.push('');
for (const t of rehomes) {
  const next = log.lines[log.lines.indexOf(t) + 1];
  md.push(`- ${t.provider}:${t.provider_event_id} ${t.event_time} M${t.mag ?? '?'}: ${t.feed_id} → ${next?.feed_id ?? '?'} (${t.reason})`);
}
if (!rehomes.length) md.push('None.');
md.push('');

// --- heal groups ---
const groups = new Map<string, string[]>(); // survivor → members (survivor first), from the fold list
for (const m of merges) {
  const s = m.survivor.feedId;
  if (!groups.has(s)) groups.set(s, [s]);
  if (!groups.get(s)!.includes(m.loser.feedId)) groups.get(s)!.push(m.loser.feedId);
}
const flagsOf = (members: EventNode[], survivor: EventNode): string[] => {
  const flags: string[] = [];
  const dts = members.map((n) => Math.abs(n.eventTimeMs - survivor.eventTimeMs) / 1000);
  const mags = members.map((n) => n.mag).filter((m): m is number => m != null);
  const depths = members.map((n) => n.depth).filter((d): d is number => d != null);
  if (Math.max(...dts) > 30) flags.push(`dt ${fmt(Math.max(...dts))} s > 30 s`);
  if (mags.length > 1 && Math.max(...mags) - Math.min(...mags) > 0.5) flags.push(`ΔM ${fmt(Math.max(...mags) - Math.min(...mags), 2)} > 0.5`);
  if (depths.length > 1 && Math.max(...depths) - Math.min(...depths) > 50) flags.push(`Δdepth ${fmt(Math.max(...depths) - Math.min(...depths), 0)} km > 50`);
  const seen = new Map<string, string>();
  for (const n of members) {
    for (const r of n.provenance) {
      const prev = seen.get(r.provider);
      if (prev && prev !== n.feedId) flags.push(`${r.provider} in two members (linked ids or a re-id)`);
      seen.set(r.provider, n.feedId);
    }
  }
  if (members.filter((n) => statusRank(n.status) >= 3).length >= 2) flags.push('two reviewed members');
  const multi = members.filter((n) => providersOf(n).length >= 2);
  if (multi.length >= 2) flags.push(`${multi.length} members with ≥ 2 providers each`);
  return [...new Set(flags)];
};
const rows = [...groups].map(([sid, ids]) => ({ survivor: state.eventMap.get(sid)!, members: ids.map((id) => before.get(id)!) }));
rows.sort((a, b) => (b.survivor.mag ?? -9) - (a.survivor.mag ?? -9) || a.survivor.eventTimeMs - b.survivor.eventTimeMs);
const bucket = (m: number | null): string => (m == null ? 'M ?' : m >= 5.5 ? 'M ≥ 5.5' : m >= 4 ? 'M 4–5.5' : m >= 2.5 ? 'M 2.5–4' : 'M < 2.5');
const hist = new Map<string, number>();
for (const g of rows) hist.set(bucket(g.survivor.mag), (hist.get(bucket(g.survivor.mag)) ?? 0) + 1);
const flagged = rows.filter((g) => flagsOf(g.members, g.survivor).length);
md.push(`## Groups the heal folds (${rows.length} groups, ${merges.length} op:merge, ${rows.reduce((a, g) => a + g.members.length, 0)} ids → ${rows.length})`);
md.push('');
md.push(`By survivor magnitude: ${[...hist].sort().map(([b, n]) => `${b}: ${n}`).join(', ') || 'none'}. Groups with a sanity flag: ${flagged.length}.`);
md.push('');
md.push('Members are the nodes as published before the heal; "d" and "Δt" are from each member\'s representative to the survivor\'s representative after the heal.');
md.push('');
for (const g of rows) {
  const s = g.survivor;
  const flags = flagsOf(g.members, s);
  md.push(`### ${s.feedId} — M${s.mag ?? '?'} ${s.magType ?? ''} ${s.status ?? ''} ${isoFromMs(s.eventTimeMs)} ${s.place ?? ''} — ${g.members.length} ids${flags.length ? ` — FLAGS: ${flags.join('; ')}` : ''}`);
  md.push('');
  md.push('| member | role | providers (aliases) | M | origin | lat, lon | depth | status | d | Δt | op:merge reason |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const n of g.members) {
    const m = merges.find((x) => x.loser.feedId === n.feedId);
    const d = haversineKm(n.lat, n.lon, s.lat, s.lon);
    const dt = (n.eventTimeMs - s.eventTimeMs) / 1000;
    md.push(`| ${n.feedId} | ${n.feedId === s.feedId ? 'survivor' : 'superseded'} | ${n.aliases.join(' ')} | ${n.mag ?? ''} ${n.magType ?? ''} | ${isoFromMs(n.eventTimeMs)} | ${fmt(n.lat, 4)}, ${fmt(n.lon, 4)} | ${n.depth ?? ''} | ${n.status ?? ''} | ${fmt(d)} km | ${fmt(dt)} s | ${m ? m.reason : ''} |`);
  }
  md.push('');
}

// --- large pairs still split ---
const big = [...state.eventMap.values()].filter((n) => n.state === 'live' && n.mag != null && n.mag >= 5.5 && n.eventTimeMs >= hotFloor).sort((a, b) => a.eventTimeMs - b.eventTimeMs);
const apart: string[] = [];
for (let i = 0; i < big.length; i++) {
  for (let j = i + 1; j < big.length; j++) {
    const a = big[i]!;
    const b = big[j]!;
    const dt = Math.abs(a.eventTimeMs - b.eventTimeMs);
    if (dt > 60_000) continue;
    const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
    if (d > 50) continue;
    apart.push(`- ${a.feedId} (M${a.mag} ${a.magType ?? ''} ${providersOf(a).join('+')} ${isoFromMs(a.eventTimeMs)} ${a.place ?? ''}) vs ${b.feedId} (M${b.mag} ${b.magType ?? ''} ${providersOf(b).join('+')} ${isoFromMs(b.eventTimeMs)} ${b.place ?? ''}): d=${fmt(d)} km dt=${fmt(dt / 1000)} s — ${resolver.whyNotMerged(a, b) ?? 'no gate blocks'}`);
  }
}
md.push(`## Live M ≥ 5.5 pairs within 50 km / 60 s that stay split (${apart.length})`);
md.push('');
md.push(...(apart.length ? apart : ['None.']));
md.push('');
if (invalid.length) {
  md.push('## Schema-invalid lines');
  md.push('');
  for (const l of invalid.slice(0, 20)) md.push(`- seq ${l.seq} ${l.op} ${l.feed_id}`);
  md.push('');
}

const report = md.join('\n');
if (outPath) writeFileSync(outPath, report + '\n');
console.log(md.slice(0, 8).join('\n'));
console.log(`\nretracted=${retractions.length} rehomed=${rehomes.length} merges=${merges.length} groups=${rows.length} flagged=${flagged.length} large_apart=${apart.length} invalid=${invalid.length}` + (outPath ? ` → ${outPath}` : ''));
