/**
 * Replay a slice of the observation log through the Resolver and report what the dedup
 * rules make of it — the review surface for a rule change (PF-1, 2026-09-28).
 *
 * Usage:
 *   npx tsx scripts/replay-dedup.ts --logs <lines.ndjson>... [--baseline <dedup.ts>] [--out <report.md>]
 *
 * Input: observation-log lines (op observe / tombstone), e.g. exported from the data branch:
 *   for h in $(git ls-tree --name-only origin/data:knowledge/observations/ingest=2026/09/25); do
 *     git show origin/data:knowledge/observations/ingest=2026/09/25/$h; done > /tmp/25.ndjson
 * The log only holds lines that changed something and replaying them in seq order rebuilds
 * the same event_map (design §8.10), so the replay IS the production decision path.
 *
 * "Before" = the feed_id every line was logged under (what production decided at the time).
 * --baseline <module> additionally replays another dedup module exporting `Resolver` (e.g.
 * `git show <sha>:src/dedup.ts` with its relative imports pointed at this checkout) over the
 * same lines, as a second "before" that rules out cross-window effects.
 *
 * The report lists: node counts, every logged group the new rules fold together (with each
 * member's solution, its distance / Δt to the survivor and whether it joined at first sight
 * or through op:merge), every logged group the new rules split, and every pair of live
 * M ≥ 5.5 events within 50 km / 60 s that did NOT fold, with the gate that kept them apart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Resolver } from '../src/dedup.js';
import { haversineKm } from '../src/geo.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation } from '../src/types.js';
import { isoFromMs } from '../src/util.js';

interface ResolverLike {
  ingest(raw: ReturnType<typeof observationToRaw>, ingestTime: string): { node: EventNode; changed: boolean; merges?: { survivor: EventNode; loser: EventNode; reason: string }[] };
  tombstoneProvider(raw: ReturnType<typeof observationToRaw>, ingestTime: string): { node: EventNode } | null;
  whyNotMerged?(a: EventNode, b: EventNode): string | null;
}
type ResolverCtor = new (map: Map<string, EventNode>, prio: Map<string, number>, cfg: Map<string, unknown>, nowMs: number, opts: { hotFloorMs?: number }) => ResolverLike;

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const logFiles: string[] = [];
for (let i = args.indexOf('--logs') + 1; i > 0 && i < args.length && !args[i]!.startsWith('--'); i++) logFiles.push(args[i]!);
if (!logFiles.length) {
  console.error('usage: replay-dedup --logs <lines.ndjson>... [--baseline <dedup.ts>] [--out <report.md>]');
  process.exit(2);
}
const baselinePath = opt('--baseline');
const outPath = opt('--out');

const lines: Observation[] = logFiles
  .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Observation)
  .sort((a, b) => a.seq - b.seq);
const key = (o: { provider: string; provider_event_id: string }): string => `${o.provider}:${o.provider_event_id}`;
const registryPath = resolve(new URL('../providers/registry.json', import.meta.url).pathname);
const registry = loadRegistry(registryPath);
const prio = priorityMap(registry);
const cfg = configMap(registry);
const lastIngestMs = Math.max(...lines.map((o) => Date.parse(o.ingest_time)));
const nowMs = lastIngestMs + 3600_000;

interface Run {
  map: Map<string, EventNode>;
  resolver: ResolverLike;
  keyToNode: Map<string, string>;
  merges: { loser: string; survivor: string; reason: string; seq: number }[];
  firstSightJoins: number;
}

function replay(Ctor: ResolverCtor): Run {
  const map = new Map<string, EventNode>();
  const resolver = new Ctor(map, prio, cfg as Map<string, unknown>, nowMs, { hotFloorMs: 0 });
  const keyToNode = new Map<string, string>();
  const merges: Run['merges'] = [];
  const seen = new Set<string>();
  let firstSightJoins = 0;
  for (const o of lines) {
    const raw = observationToRaw(o);
    if (o.op === 'tombstone') {
      resolver.tombstoneProvider(raw, o.ingest_time);
      continue;
    }
    if (o.op !== 'observe') continue;
    const k = key(o);
    const fresh = !seen.has(k);
    seen.add(k);
    const before = map.size;
    const r = resolver.ingest(raw, o.ingest_time);
    if (fresh && map.size === before) firstSightJoins++;
    for (const m of r.merges ?? []) merges.push({ loser: m.loser.feedId, survivor: m.survivor.feedId, reason: m.reason, seq: o.seq });
  }
  // Final home of every key: the live node whose aliases carry it.
  for (const n of map.values()) if (n.state === 'live') for (const a of n.aliases) keyToNode.set(a, n.feedId);
  return { map, resolver, keyToNode, merges, firstSightJoins };
}

const after = replay(Resolver as unknown as ResolverCtor);
let baseline: Run | null = null;
if (baselinePath) {
  const mod = (await import(pathToFileURL(resolve(baselinePath)).href)) as { Resolver: ResolverCtor };
  baseline = replay(mod.Resolver);
}

// The id each key was logged under (constant per key — production had no merges).
const loggedGroups = new Map<string, Set<string>>();
const lastLine = new Map<string, Observation>();
for (const o of lines) {
  if (o.op !== 'observe') continue;
  const k = key(o);
  (loggedGroups.get(o.feed_id) ?? loggedGroups.set(o.feed_id, new Set()).get(o.feed_id)!).add(k);
  lastLine.set(k, o);
}
const keyToLogged = new Map<string, string>();
for (const [fid, keys] of loggedGroups) for (const k of keys) keyToLogged.set(k, fid);

// The reference grouping the diff below is taken against: the baseline replay when given
// (same lines, same empty start — isolates the rule change), else the logged ids (which
// also carry cross-window effects: a report of an event minted before the slice starts
// was logged under that older id, but has to mint afresh here).
const groupsOf = (keyToId: Map<string, string>): Map<string, Set<string>> => {
  const g = new Map<string, Set<string>>();
  for (const [k, fid] of keyToId) (g.get(fid) ?? g.set(fid, new Set()).get(fid)!).add(k);
  return g;
};
const refLabel = baseline ? 'baseline replay' : 'logged ids';
const keyToRef = baseline ? baseline.keyToNode : keyToLogged;
const refGroups = groupsOf(keyToRef);
const afterGroups = groupsOf(after.keyToNode);
const magBucket = (m: number | null): string => (m == null ? 'M ?' : m >= 5.5 ? 'M ≥ 5.5' : m >= 4 ? 'M 4–5.5' : m >= 2.5 ? 'M 2.5–4' : 'M < 2.5');

const fmt = (n: number, d = 1): string => n.toFixed(d);
const md: string[] = [];
const live = [...after.map.values()].filter((n) => n.state === 'live');
const superseded = [...after.map.values()].filter((n) => n.state === 'superseded');
md.push(`# Dedup replay report`);
md.push('');
md.push(`Lines: ${lines.length} (${lines.filter((o) => o.op === 'observe').length} observe, ${lines.filter((o) => o.op === 'tombstone').length} tombstone), ingest ${lines[0]!.ingest_time} → ${lines[lines.length - 1]!.ingest_time}, ${keyToLogged.size} provider ids.`);
md.push('');
md.push(`| | nodes | live | superseded | op:merge | new ids that joined an existing node at first sight |`);
md.push(`|---|---|---|---|---|---|`);
md.push(`| logged feed ids (production, includes events minted before the slice) | ${loggedGroups.size} | ${loggedGroups.size} | 0 | 0 | ${keyToLogged.size - loggedGroups.size} |`);
if (baseline) {
  const bl = [...baseline.map.values()];
  md.push(`| baseline replay (pre-change rules, empty start) | ${bl.length} | ${bl.filter((n) => n.state === 'live').length} | ${bl.filter((n) => n.state === 'superseded').length} | ${baseline.merges.length} | ${baseline.firstSightJoins} |`);
}
md.push(`| after (this checkout, empty start) | ${after.map.size} | ${live.length} | ${superseded.length} | ${after.merges.length} | ${after.firstSightJoins} |`);
md.push('');
const mergeHist = new Map<string, number>();
for (const m of after.merges) {
  const b = magBucket(after.map.get(m.survivor)?.mag ?? null);
  mergeHist.set(b, (mergeHist.get(b) ?? 0) + 1);
}
md.push(`op:merge by survivor magnitude: ${[...mergeHist].sort().map(([b, n]) => `${b}: ${n}`).join(', ') || 'none'}.`);
md.push('');

// Folded groups: an after-node whose keys span ≥ 2 reference groups.
const folded: { fid: string; ref: string[] }[] = [];
for (const [fid, keys] of afterGroups) {
  const ref = [...new Set([...keys].map((k) => keyToRef.get(k)).filter((x): x is string => !!x))];
  if (ref.length >= 2) folded.push({ fid, ref });
}
folded.sort((a, b) => {
  const ma = after.map.get(a.fid)!.mag ?? -1;
  const mb = after.map.get(b.fid)!.mag ?? -1;
  return mb - ma || a.fid.localeCompare(b.fid);
});
const foldHist = new Map<string, number>();
for (const g of folded) {
  const b = magBucket(after.map.get(g.fid)!.mag);
  foldHist.set(b, (foldHist.get(b) ?? 0) + 1);
}
md.push(`## Groups the new rules fold together (${folded.length}; vs ${refLabel})`);
md.push('');
md.push(`${[...foldHist].sort().map(([b, n]) => `${b}: ${n}`).join(', ') || 'none'}.`);
md.push('');
md.push(`Each block is one live event after the change; its rows are grouped by the ${refLabel} they belonged to before. "how" says whether that group joined the survivor at first sight (the widened window / the re-id fold) or was minted and later superseded by op:merge. Distances and Δt are from each row's last logged solution to the survivor's representative.`);
md.push('');
for (const g of folded) {
  const n = after.map.get(g.fid)!;
  md.push(`### ${g.fid} — M${n.mag ?? '?'} ${n.magType ?? ''} ${n.status ?? ''} ${isoFromMs(n.eventTimeMs)} ${n.place ?? ''} (${n.chosenProvider}) — ${afterGroups.get(g.fid)!.size} ids from ${g.ref.length} groups`);
  md.push('');
  md.push(`| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const rid of g.ref) {
    const node = after.map.get(rid);
    const merge = after.merges.find((m) => m.loser === rid);
    const how = rid === g.fid ? 'survivor' : merge ? `op:merge (${merge.reason})` : node?.state === 'superseded' ? `superseded by ${node.supersededBy}` : 'joined at first sight';
    for (const k of [...refGroups.get(rid)!].filter((k) => afterGroups.get(g.fid)!.has(k))) {
      const o = lastLine.get(k)!;
      const d = haversineKm(o.lat, o.lon, n.lat, n.lon);
      const dt = (Date.parse(o.event_time) - n.eventTimeMs) / 1000;
      md.push(`| ${rid} | ${how} | ${k} | ${o.mag ?? ''} ${o.magType ?? ''} | ${o.event_time} | ${o.lat}, ${o.lon} | ${o.depth ?? ''} | ${o.status ?? ''} | ${fmt(d)} km | ${fmt(dt)} s |`);
    }
  }
  md.push('');
}

// Split groups: a reference group whose keys now live in ≥ 2 after-nodes.
const split: { rid: string; nodes: string[] }[] = [];
for (const [rid, keys] of refGroups) {
  const nodes = [...new Set([...keys].map((k) => after.keyToNode.get(k)).filter((x): x is string => !!x))];
  if (nodes.length >= 2) split.push({ rid, nodes });
}
md.push(`## Groups the new rules split (${split.length}; vs ${refLabel})`);
md.push('');
if (!split.length) md.push('None.');
for (const s of split) {
  md.push(`### ${s.rid} → ${s.nodes.join(', ')}`);
  md.push('');
  for (const k of refGroups.get(s.rid)!) {
    const o = lastLine.get(k)!;
    md.push(`- ${k} → ${after.keyToNode.get(k)}: M${o.mag ?? '?'} ${o.event_time} ${o.lat}, ${o.lon} depth ${o.depth ?? '?'} ${o.status ?? ''}`);
  }
  md.push('');
}

// Large pairs still apart.
const big = live.filter((n) => n.mag != null && n.mag >= 5.5).sort((a, b) => a.eventTimeMs - b.eventTimeMs);
const apart: string[] = [];
for (let i = 0; i < big.length; i++) {
  for (let j = i + 1; j < big.length; j++) {
    const a = big[i]!;
    const b = big[j]!;
    const dt = Math.abs(a.eventTimeMs - b.eventTimeMs);
    if (dt > 60_000) continue;
    const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
    if (d > 50) continue;
    const why = after.resolver.whyNotMerged ? after.resolver.whyNotMerged(a, b) : 'n/a';
    apart.push(`- ${a.feedId} (M${a.mag} ${a.chosenProvider} ${isoFromMs(a.eventTimeMs)} ${a.place ?? ''}) vs ${b.feedId} (M${b.mag} ${b.chosenProvider} ${isoFromMs(b.eventTimeMs)} ${b.place ?? ''}): d=${fmt(d)} km dt=${fmt(dt / 1000)} s — ${why ?? 'no gate blocks: the merge pass never ran on this pair'}`);
  }
}
md.push(`## Live M ≥ 5.5 pairs within 50 km / 60 s that did NOT fold (${apart.length})`);
md.push('');
md.push(...(apart.length ? apart : ['None.']));
md.push('');
md.push(`## Live M ≥ 5.5 events after the change (${big.length})`);
md.push('');
for (const n of big) md.push(`- ${n.feedId} M${n.mag} ${n.magType ?? ''} ${n.status ?? ''} ${isoFromMs(n.eventTimeMs)} ${n.place ?? ''} — ${new Set(n.provenance.map((r) => r.provider)).size} providers, ${n.aliases.length} ids`);
md.push('');

const report = md.join('\n');
if (outPath) writeFileSync(outPath, report + '\n');
console.log(report.split('\n').slice(0, 12).join('\n'));
console.log(`\nfolded=${folded.length} split=${split.length} apart=${apart.length}` + (outPath ? ` → ${outPath}` : ''));
