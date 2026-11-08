import { eventDayKey } from './bitemporal.js';
import { AFAD_PROVIDER, afadLegacyRow } from './correction.js';
import { Resolver } from './dedup.js';
import { iscUntrustedMagnitude } from './fdsn.js';
import { configMap, priorityMap } from './providers.js';
import type { EventNode, ProviderConfig } from './types.js';

export { AFAD_LEGACY_OFFSET_MS, afadLegacyRow } from './correction.js';
export { ISC_UNTRUSTED_MW_AUTHORS, iscUntrustedMagnitude } from './fdsn.js';

/**
 * The corrections the fixed parsers make, applied to rows already published (APIs.md, *Turkey (AFAD)* and *ISC*): the
 * monthly archives and the frozen day partitions keep the rows as the parsers of their time read them, and the offline
 * re-merge and the statistics builder read them back from there. One function, so both apply the same rules:
 *
 *  - AFAD (PF-5e): every AFAD row stored before 2026-10-01 is 3 h early (the parser read AFAD's UTC `date` as Turkish
 *    time). A row whose own `fields` re-read exactly 3 h later and otherwise the same (afadLegacyRow) is re-timed, in an
 *    event of AFAD's rows only. In an event with another source's rows the AFAD row joined that event at its wrong time;
 *    moving it out would mint an event (the one-time correction and the remediation editions do that, through
 *    Resolver.correctReport), which an offline re-merge never does, so it is left as it is and counted
 *    (`afad_joined_kept`; 28 of the 13,547 AFAD rows of the archives 2025-08 and 2025-09, each beside an EMSC
 *    solution of an M1-3 quake 3 h earlier).
 *  - ISC: a row whose magnitude is a moment magnitude by an author the feed does not take (iscUntrustedMagnitude:
 *    Geoscience Australia's automatic Mw in ISC's preliminary bulletin) loses `mag` and `magType`; `fields` keep the
 *    value. ISC's times are right: its rows that matched no ComCat quake were real (mostly aftershock) origins carrying
 *    an Mw 1-3 units too high, and so a magnitude that matched no ComCat quake of their size.
 *
 * Every state is normalized (a superseded line's frozen rows too), and the representative of every changed event is
 * re-derived from its rows (Resolver.rederive: the time, place and magnitude its preferred row now gives). Nothing is
 * minted, folded, withdrawn or logged and no revision moves; the folds the corrected rows allow are the re-merge's.
 * Pure: the input nodes are not changed; a changed node is returned as a copy, an unchanged one as the same object, in
 * the input order. Idempotent: normalized rows are left as they are.
 */

export interface RowNormalizeCounts {
  /** AFAD rows re-timed (+3 h) in an event of AFAD's rows only. */
  afad_retimed: number;
  /** AFAD rows stored 3 h early in an event that holds another source's rows: left as they are. */
  afad_joined_kept: number;
  /** ISC rows whose magnitude and magnitude type were dropped. */
  isc_magnitude_dropped: number;
  /** Of those, rows that represented their event. */
  isc_magnitude_dropped_chosen: number;
  /** Events with a changed row (each a copy, its representative re-derived). */
  events_changed: number;
  /** Of those, events whose representative time is now on another UTC day. */
  day_changed: number;
}

export interface RowNormalizeResult {
  rows: EventNode[];
  counts: RowNormalizeCounts;
  /** Feed ids of the changed events, in input order. */
  changed: string[];
  /** Feed ids of the events holding an AFAD row left 3 h early (`afad_joined_kept`), in input order. */
  afadJoined: string[];
}

export function emptyRowNormalizeCounts(): RowNormalizeCounts {
  return { afad_retimed: 0, afad_joined_kept: 0, isc_magnitude_dropped: 0, isc_magnitude_dropped_chosen: 0, events_changed: 0, day_changed: 0 };
}

export function normalizeRows(nodes: readonly EventNode[], registry: ProviderConfig[]): RowNormalizeResult {
  const counts = emptyRowNormalizeCounts();
  const changed: string[] = [];
  const afadJoined: string[] = [];
  const copies = new Map<string, { copy: EventNode; beforeMs: number }>();
  const out = nodes.map((node) => {
    const onlyAfad = node.provenance.every((r) => r.provider === AFAD_PROVIDER);
    let copy: EventNode | null = null;
    const own = (): EventNode => (copy ??= structuredClone(node));
    let joined = false;
    node.provenance.forEach((r, i) => {
      const again = afadLegacyRow(r);
      if (again) {
        if (!onlyAfad) {
          counts.afad_joined_kept++;
          joined = true;
          return;
        }
        const row = own().provenance[i]!;
        row.eventTimeMs = again.eventTimeMs;
        row.providerUpdatedMs = again.providerUpdatedMs;
        counts.afad_retimed++;
        return;
      }
      if (iscUntrustedMagnitude(r.provider, r.fields) && (r.mag != null || r.magType != null)) {
        const row = own().provenance[i]!;
        row.mag = null;
        row.magType = null;
        counts.isc_magnitude_dropped++;
        if (r.chosen) counts.isc_magnitude_dropped_chosen++;
      }
    });
    if (joined) afadJoined.push(node.feedId);
    if (!copy) return node;
    copies.set(node.feedId, { copy, beforeMs: node.eventTimeMs });
    changed.push(node.feedId);
    return copy;
  });
  if (copies.size) {
    // A throwaway Resolver over the copies only: rederive reads the provider order and the rows' own fields.
    const map = new Map([...copies].map(([id, c]) => [id, c.copy]));
    const r = new Resolver(map, priorityMap(registry), configMap(registry), 0, { hotFloorMs: 0, merge: false });
    for (const { copy, beforeMs } of copies.values()) {
      r.rederive(copy);
      counts.events_changed++;
      if (eventDayKey(copy.eventTimeMs) !== eventDayKey(beforeMs)) counts.day_changed++;
    }
  }
  return { rows: out, counts, changed, afadJoined };
}

/** The name the 2026-11-08 statistics plan gives normalizeRows (it normalizes ISC magnitudes too: ISC's times are
 *  right, see the module comment). */
export const normalizeRowTimes = normalizeRows;
