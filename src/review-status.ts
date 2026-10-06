import type { EventNode, ProvenanceRow } from './types.js';

/**
 * `review_status` (PF-1 extras, round 15): whether a solution is the source's automatic one or one a seismologist has
 * reviewed, normalized to `"automatic"` | `"reviewed"`, for the sources whose answer says so. Derived at publish time
 * from what the stored row already holds, so it reaches every row the hot window keeps (and nothing is re-fetched or
 * re-logged); null when the source does not say.
 *
 * What each source's answer says (checked 2026-10-06 against the rows of 2026-10-01..05 on origin/data and each FDSN
 * service's QuakeML for the same events):
 * - `status` already normalized by the adapter: ComCat (`usgs`, its `status` automatic | reviewed), AEC (version 2 or
 *   an analyst magnitude), IMO (`evaluation_mode`), KOERI (a "REVISE" solution), OVSICORI and IG-EPN ("revisado"),
 *   GeoSphere (`is_verified`), CWA (reviewed reports only), NCS ("Reviewed"), SSN (preliminary = automatic).
 * - The origin's author in the FDSN text answer (column Author), for the SeisComP services that publish it: an
 *   automatic locator (`scautoloc@wvf01`, `l1autoloc@sc3-prime`, ETHZ's `NLoB_auloc@sc20a`, `scrtdd@…`) or a machine
 *   picker (`PhaseNet`) is automatic, a person's login is reviewed. Against the services' own QuakeML
 *   `evaluationMode` of the same events (2026-09-26..10-06): RéNaSS 300 of 300 agree (29 automatic), NOA 300 of 300
 *   (1), IPGP 119 of 119 (8), ETHZ 80 of 80 manual (its public service lists reviewed solutions; the automatic author
 *   names are from the 2025-03-10 all-origins fixture). RESIF serves RéNaSS's catalogue (same authors).
 * - Not said by what the feed reads: EMSC (FDSN JSON), GEOFON, KNMI (no author in the text answer), INGV
 *   (`SURVEY-INGV` for automatic and reviewed alike), GeoNet, NCEDC / SCEDC (network codes; their events reach the feed
 *   through ComCat, which says it), NRCan, and the other custom adapters. EMSC's and GEOFON's QuakeML carry
 *   `evaluationMode`; reading it is a separate query (APIs.md, Review status).
 */
export type ReviewStatus = 'automatic' | 'reviewed';

/** FDSN text sources whose Author column names the origin's author (SeisComP), and how an automatic one reads. */
export const AUTHOR_MODE_PROVIDERS: ReadonlySet<string> = new Set(['renass', 'resif', 'noa', 'ipgp', 'ethz']);
const AUTOMATIC_AUTHOR = /autoloc|auloc@|_aloc@|_reloc@|_scloc@|scanloc|^scrtdd@|^phasenet$/i;

export function reviewStatusOfRow(row: Pick<ProvenanceRow, 'provider' | 'status' | 'fields'>): ReviewStatus | null {
  const s = row.status?.trim().toLowerCase();
  if (s === 'reviewed' || s === 'automatic') return s;
  if (AUTHOR_MODE_PROVIDERS.has(row.provider)) {
    const author = row.fields?.['Author'];
    if (typeof author !== 'string') return null;
    const a = author.trim();
    if (!a || a === '--') return null;
    return AUTOMATIC_AUTHOR.test(a) ? 'automatic' : 'reviewed';
  }
  return null;
}

/** The event's review status: its representative row's (the solution its top-level fields come from). */
export function reviewStatusOfNode(node: EventNode): ReviewStatus | null {
  const chosen = node.provenance.find((r) => r.chosen) ?? node.provenance[0];
  return chosen ? reviewStatusOfRow(chosen) : null;
}
