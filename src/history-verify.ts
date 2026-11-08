import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { SCHEMA_DIR } from './config.js';
import type { EditionMeta, RawInput } from './history-build.js';
import { type Period, dayKeyOf, periodDays } from './history-config.js';
import { screenReason } from './quality.js';

/**
 * Deep history (PF-5j): the checks every events edition passes before it is uploaded (src/history.ts) and that
 * scripts/history-verify.ts runs again on downloaded assets. Every line, not a sample: the schema of the day
 * partitions (schema/feature.schema.json), a non-empty provenance, the day of each event, one event per feed id and
 * one per source id, the counts `_edition.json` states, and, given the raw assets, every fetched row accounted for and
 * the source's own count matched.
 */

let validator: ValidateFunction | null = null;
function featureValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validator = ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, 'feature.schema.json'), 'utf8')) as object);
  }
  return validator;
}

interface FeatureLine {
  id?: string;
  properties?: { time?: number; mag?: number | null; feed?: { feed_id?: string; state?: string; superseded_by?: string; provenance?: { provider?: string; native_id?: string; mag?: number | null }[] } };
}

export interface EditionCheck {
  errors: string[];
  /** Live lines (every line of an edition that was never re-merged). */
  events: number;
  /** Distinct source ids over all lines (a re-merged loser keeps a frozen copy of the rows its survivor took). */
  rows: number;
  /** Source ids in the day files (every line). */
  keys: Set<string>;
  /** Feed ids in the day files (every line) and how many lines. */
  ids: Set<string>;
  lines: number;
}

export function verifyEdition(
  dayFiles: Map<string, string>,
  opts: {
    period: Period;
    boundary: string;
    archivedDays: ReadonlySet<string>;
    meta?: EditionMeta;
    raws?: RawInput[];
    /** A re-merged edition (meta.merge): the check of the edition it was merged from, in place of `raws`. Same feed
     *  ids, the same number of lines, and every source id it held. */
    prev?: Pick<EditionCheck, 'ids' | 'keys' | 'lines'>;
  },
): EditionCheck {
  const errors: string[] = [];
  const err = (m: string): void => {
    if (errors.length < 50) errors.push(m);
  };
  const v = featureValidator();
  const days = new Set(periodDays(opts.period));
  const ids = new Set<string>();
  const keys = new Set<string>();
  const liveKeys = new Set<string>();
  const states = new Map<string, string>();
  const pointers: { at: string; from: string; to: string }[] = [];
  const offUnit = new Set(opts.meta?.merge?.off_unit ?? []);
  const intoNewer = new Map((opts.meta?.merge?.into_newer ?? []).map((x) => [x.loser, x.survivor]));
  let events = 0;
  let lines = 0;
  for (const [day, text] of dayFiles) {
    if (!days.has(day)) err(`${day}: not a day of ${opts.period.key}`);
    if (day >= opts.boundary) err(`${day}: not before the boundary ${opts.boundary}`);
    if (opts.archivedDays.has(day)) err(`${day}: already in an archive-YYYY-MM Release`);
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      let f: FeatureLine;
      try {
        f = JSON.parse(line) as FeatureLine;
      } catch {
        err(`${day}:${i + 1} is not JSON`);
        continue;
      }
      lines++;
      if (!v(f)) err(`${day}:${i + 1} schema: ${(v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
      const feed = f.properties?.feed;
      const t = f.properties?.time;
      if ((typeof t !== 'number' || dayKeyOf(t) !== day) && !(f.id && offUnit.has(f.id))) err(`${day}:${i + 1} time ${String(t)} is not on ${day}`);
      // A re-merged edition holds superseded losers beside the live events; nothing is ever tombstoned offline.
      const live = feed?.state === 'live';
      if (!live && !(feed?.state === 'superseded' && opts.meta?.merge)) err(`${day}:${i + 1} state ${String(feed?.state)}`);
      if (live) events++;
      if (f.id) states.set(f.id, String(feed?.state));
      if (feed?.state === 'superseded') pointers.push({ at: `${day}:${i + 1}`, from: f.id ?? '', to: feed.superseded_by ?? '' });
      if (!f.id || f.id !== feed?.feed_id) err(`${day}:${i + 1} id ${String(f.id)} differs from feed_id ${String(feed?.feed_id)}`);
      if (f.id) {
        if (ids.has(f.id)) err(`${day}:${i + 1} feed id ${f.id} is in the edition twice`);
        ids.add(f.id);
      }
      const prov = feed?.provenance ?? [];
      if (!prov.length) err(`${day}:${i + 1} empty provenance`);
      for (const r of prov) {
        const k = `${r.provider}:${r.native_id}`;
        keys.add(k);
        if (!live) continue;
        if (liveKeys.has(k)) err(`${day}:${i + 1} ${k} is in two events`);
        liveKeys.add(k);
      }
    }
  }
  const rows = keys.size;
  // Every loser names a live event of the edition, or (listed in meta.merge.into_newer) one of the newer month: never a
  // chain, never a line that is not there.
  for (const p of pointers) {
    const st = states.get(p.to);
    if (st === 'live') continue;
    if (st == null && intoNewer.get(p.from) === p.to) continue;
    err(`${p.at} ${p.from} superseded_by ${p.to || '(none)'}, ${st == null ? 'not in the edition nor in merge.into_newer' : `a ${st} line (a chain)`}`);
  }
  for (const id of offUnit) if (!ids.has(id)) err(`merge.off_unit lists ${id}, which is in no day file`);
  const m = opts.meta;
  if (m) {
    if (m.period !== opts.period.key) err(`_edition.json is for ${m.period}`);
    if (m.events !== events) err(`_edition.json says ${m.events} events, the day files hold ${events}`);
    if (m.rows.written !== rows) err(`_edition.json says ${m.rows.written} rows written, the day files hold ${rows}`);
    const listed = [...dayFiles.keys()].sort().join(',');
    if (m.days.join(',') !== listed) err(`_edition.json lists days ${m.days.join(',')}, the files are ${listed}`);
    if (m.rows.fetched !== m.rows.bad_coords + m.rows.coordinateless + m.rows.written + m.rows.joined_newer + m.rows.below_floor) {
      err(`_edition.json row counts do not add up (${JSON.stringify(m.rows)})`);
    }
    if (m.joined_newer.length !== m.rows.joined_newer) err('_edition.json joined_newer list and count differ');
    if (m.lines != null && m.lines !== lines) err(`_edition.json says ${m.lines} lines, the day files hold ${lines}`);
    if (m.superseded != null && m.superseded !== lines - events) err(`_edition.json says ${m.superseded} superseded, the day files hold ${lines - events}`);
  }
  if (opts.prev) {
    const prev = opts.prev;
    if (prev.lines !== lines) err(`${prev.lines} lines in the edition merged from, ${lines} here`);
    let lostIds = 0;
    for (const id of prev.ids) if (!ids.has(id)) lostIds++;
    let newIds = 0;
    for (const id of ids) if (!prev.ids.has(id)) newIds++;
    if (lostIds || newIds) err(`feed ids differ from the edition merged from: ${lostIds} lost, ${newIds} new`);
    let lostKeys = 0;
    for (const k of prev.keys) if (!keys.has(k)) lostKeys++;
    if (lostKeys) err(`${lostKeys} source id(s) of the edition merged from are in no line`);
  }
  if (opts.raws) {
    const joined = new Set((m?.joined_newer ?? []).map((j) => `${j.provider}:${j.native_id}`));
    let fetched = 0;
    let screened = 0;
    let missing = 0;
    for (const r of opts.raws) {
      const h = r.header;
      fetched += r.rows.length;
      if (h.provider_count != null) {
        // Events the source counted but answered as empty elements (EMSC) are the asset's recorded gap, window by window.
        const windowRows = h.windows.reduce((s, w) => s + w.rows + (w.unserialized ?? 0), 0);
        const unserialized = h.unserialized_rows ?? 0;
        if (h.windows.reduce((s, w) => s + (w.unserialized ?? 0), 0) !== unserialized) err(`${r.asset}: the windows' empty elements differ from unserialized_rows ${unserialized}`);
        if (windowRows !== h.provider_count) err(`${r.asset}: the windows hold ${windowRows} rows where the source counted ${h.provider_count}`);
        if (h.response_rows + unserialized !== h.provider_count) err(`${r.asset}: ${h.response_rows} rows answered (and ${unserialized} empty) where the source counted ${h.provider_count}`);
      }
      for (const row of r.rows) {
        if (screenReason(row)) {
          screened++;
          continue;
        }
        const k = `${row.provider}:${row.providerEventId}`;
        if (!keys.has(k) && !joined.has(k)) missing++;
      }
    }
    // With no magnitude floor every kept row is written or joined the neighbour; with one, the missing rows are the
    // ones under it.
    const below = m?.rows.below_floor ?? 0;
    if (missing !== below) err(`${missing} fetched rows are in no event and not joined to the neighbour (below the floor: ${below})`);
    if (m && m.rows.fetched !== fetched) err(`_edition.json says ${m.rows.fetched} rows fetched, the raw assets hold ${fetched}`);
    if (m && m.rows.bad_coords + m.rows.coordinateless !== screened) err(`_edition.json says ${m.rows.bad_coords + m.rows.coordinateless} rows screened, the raw assets hold ${screened}`);
  }
  return { errors, events, rows, keys, ids, lines };
}
