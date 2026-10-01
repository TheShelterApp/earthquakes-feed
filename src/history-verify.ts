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
  properties?: { time?: number; mag?: number | null; feed?: { feed_id?: string; state?: string; provenance?: { provider?: string; native_id?: string; mag?: number | null }[] } };
}

export interface EditionCheck {
  errors: string[];
  events: number;
  rows: number;
  /** Source ids in the day files. */
  keys: Set<string>;
}

export function verifyEdition(
  dayFiles: Map<string, string>,
  opts: { period: Period; boundary: string; archivedDays: ReadonlySet<string>; meta?: EditionMeta; raws?: RawInput[] },
): EditionCheck {
  const errors: string[] = [];
  const err = (m: string): void => {
    if (errors.length < 50) errors.push(m);
  };
  const v = featureValidator();
  const days = new Set(periodDays(opts.period));
  const ids = new Set<string>();
  const keys = new Set<string>();
  let events = 0;
  let rows = 0;
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
      events++;
      if (!v(f)) err(`${day}:${i + 1} schema: ${(v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
      const feed = f.properties?.feed;
      const t = f.properties?.time;
      if (typeof t !== 'number' || dayKeyOf(t) !== day) err(`${day}:${i + 1} time ${String(t)} is not on ${day}`);
      if (feed?.state !== 'live') err(`${day}:${i + 1} state ${String(feed?.state)}`);
      if (!f.id || f.id !== feed?.feed_id) err(`${day}:${i + 1} id ${String(f.id)} differs from feed_id ${String(feed?.feed_id)}`);
      if (f.id) {
        if (ids.has(f.id)) err(`${day}:${i + 1} feed id ${f.id} is in the edition twice`);
        ids.add(f.id);
      }
      const prov = feed?.provenance ?? [];
      if (!prov.length) err(`${day}:${i + 1} empty provenance`);
      for (const r of prov) {
        const k = `${r.provider}:${r.native_id}`;
        if (keys.has(k)) err(`${day}:${i + 1} ${k} is in two events`);
        keys.add(k);
        rows++;
      }
    }
  }
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
        const windowRows = h.windows.reduce((s, w) => s + w.rows, 0);
        if (windowRows !== h.provider_count) err(`${r.asset}: the windows hold ${windowRows} rows where the source counted ${h.provider_count}`);
        if (h.response_rows !== h.provider_count) err(`${r.asset}: ${h.response_rows} rows answered where the source counted ${h.provider_count}`);
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
  return { errors, events, rows, keys };
}
