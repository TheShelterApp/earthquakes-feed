import { TEMPORAL_MS } from './config.js';
import { getText, parseTmd, pinnedCa, tmdEventPageRow } from './custom.js';
import type { EventNode, ProviderConfig, RawObs } from './types.js';
import { isoFromMs } from './util.js';

/**
 * Recovery of events a rolling source listed while the feed could not read it (round 25).
 *
 * TMD's map-events.json lists only its last 20 events (about 2.5 days). From 2026-10-09 02:00 to 10-13 18:26 UTC the
 * feed could not read it (a renewed leaf under another intermediate, then a moved file; fixed in #100), and the events
 * TMD numbered 17182..17198 (10-09 11:32 → 10-10 15:02 UTC) left the file before the fix. TMD keeps a page per event
 * (`https://eq.tmd.go.th/EQ<id>`, the file's `path`), so a hand-dispatched aggregate run with the input `recover`
 * (`tmd:17182-17198`, env FEED_RECOVER) reads those pages, one request at a time and RECOVER_SPACING_MS apart, turns
 * each into the file row it stands for (tmdEventPageRow) and that into a report with the adapter's own parser
 * (parseTmd). The reports then take the live path of the same run: the hot-window filter, the ingest screen, the
 * Resolver (its id and space matches, TMD's 50 km window included), op:observe lines in the observation log (each with
 * a `reason` naming the page, recoveredReason), the regular heal and the derive step. Nothing else changes: a report
 * older than the hot window (less one identity window of margin) is read but not ingested (`outside_window`), so frozen
 * days are never rewritten; and a report the feed already holds is an unchanged re-report, a no-op, so a second run
 * with the same input appends nothing.
 *
 * While TMD's file had empty ids (2026-08-18 → 10-13) the feed named its reports by origin second (`t20261008074512`,
 * parseTmd; read from 2026-10-04 on). A page whose report the feed holds under that name is skipped (`held_as`): its
 * numeric id is another id of TMD to the Resolver, which would keep the two apart as two quakes
 * (Resolver.sameProviderDistinct).
 *
 * Fail-open, like every fetch of the run: a page that fails is listed (`failed`) and the run goes on; a spec that does
 * not parse, or names a provider without a page reader, recovers nothing and says why (`error`).
 */

/** At most this many ids per run: about a minute of requests at RECOVER_SPACING_MS. */
export const RECOVER_MAX_IDS = 50;
/** The pause between the starts of two page requests (one host): at most one request a second. */
export const RECOVER_SPACING_MS = 1_200;
/** No page request starts after this much time in the recovery: the aggregate step has 4 minutes in all, and its
 *  live fetches and ingest usually take seconds. */
export const RECOVER_DEADLINE_MS = 90_000;
/** Attempts per page (spaced like any request). */
export const RECOVER_ATTEMPTS = 2;

/** A source whose events can be read one by one from pages it keeps after its rolling file drops them. */
interface PageReader {
  url: (cfg: ProviderConfig, id: string) => string;
  /** The page as the rolling file's row, or null when it holds no event. */
  row: (body: string, id: string) => Record<string, unknown> | null;
  /** The adapter's own parser of the rolling file. */
  parse: (raw: unknown, providerId: string) => RawObs[];
  /** The names the feed may hold the same report under (TMD's origin-second names). */
  oldNames: (r: RawObs) => string[];
}

const PAGE_READERS: Record<string, PageReader> = {
  tmd: {
    url: (cfg, id) => new URL(`/EQ${id}`, cfg.base).href,
    row: tmdEventPageRow,
    parse: parseTmd,
    oldNames: (r) => [`t${new Date(r.eventTimeMs).toISOString().slice(0, 19).replace(/\D/g, '')}`],
  },
};

export interface RecoverSpec {
  provider: string;
  ids: string[];
}

/** `tmd:17182-17198` or `tmd:17182-17190,17195`: one provider with a page reader, numeric ids and ranges, ascending
 *  and unique after expansion, at most RECOVER_MAX_IDS. Throws on anything else. */
export function parseRecoverSpec(spec: string): RecoverSpec {
  const m = spec.trim().match(/^([a-z0-9_-]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
  if (!m) throw new Error(`recover: "${spec}" is not <provider>:<id>[-<id>][,...] (e.g. tmd:17182-17198)`);
  const provider = m[1]!;
  if (!PAGE_READERS[provider]) throw new Error(`recover: no page reader for "${provider}" (only ${Object.keys(PAGE_READERS).join(', ')})`);
  const ids = new Set<number>();
  for (const part of m[2]!.split(',')) {
    const [a, b] = part.split('-').map(Number) as [number, number | undefined];
    const hi = b ?? a;
    if (hi < a) throw new Error(`recover: range ${part} runs backwards`);
    if (hi - a >= RECOVER_MAX_IDS) throw new Error(`recover: more than ${RECOVER_MAX_IDS} ids`);
    for (let i = a; i <= hi; i++) ids.add(i);
  }
  if (ids.size > RECOVER_MAX_IDS) throw new Error(`recover: more than ${RECOVER_MAX_IDS} ids`);
  return { provider, ids: [...ids].sort((x, y) => x - y).map(String) };
}

export interface RecoverOutcome {
  provider: string | null;
  /** Ids in the spec. */
  asked: number;
  /** The reports read back, to be ingested by the run (none outside the hot window, none held under an old name). */
  rows: RawObs[];
  /** The page each report was read from. */
  pages: Map<RawObs, string>;
  /** Pages that hold no event. */
  empty: string[];
  /** `<id>=<old name>`: the feed already holds the report under that name. */
  held_as: string[];
  /** `<id>@<origin>`: older than the hot window, not ingested (frozen and past days are never rewritten here). */
  outside_window: string[];
  /** `<id>: <error>` after RECOVER_ATTEMPTS attempts. */
  failed: string[];
  /** Ids not asked for before RECOVER_DEADLINE_MS. */
  unasked: string[];
  error?: string;
}

export interface RecoverDeps {
  fetchPage?: (url: string, cfg: ProviderConfig) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultFetch = (url: string, cfg: ProviderConfig): Promise<string> =>
  // One attempt per call: the retry is spaced like any other request (recoverReports), getText's own is not.
  getText(url, { timeoutMs: 15_000, retries: 0, ca: cfg.tlsIntermediates?.length ? pinnedCa(cfg) : undefined });

/** The ids (`provider:nativeId`) of `provider` the event map holds, in any event and any state. */
export function heldIds(eventMap: ReadonlyMap<string, EventNode>, provider: string): Set<string> {
  const held = new Set<string>();
  for (const node of eventMap.values()) {
    for (const r of node.provenance) if (r.provider === provider) held.add(`${provider}:${r.nativeId}`);
    for (const a of node.aliases) if (a.startsWith(`${provider}:`)) held.add(a);
  }
  return held;
}

/** Read the pages the spec names (see the file comment). Never throws. */
export async function recoverReports(
  spec: string,
  active: readonly ProviderConfig[],
  eventMap: ReadonlyMap<string, EventNode>,
  hotFloorMs: number,
  deps: RecoverDeps = {},
): Promise<RecoverOutcome> {
  const out: RecoverOutcome = { provider: null, asked: 0, rows: [], pages: new Map(), empty: [], held_as: [], outside_window: [], failed: [], unasked: [] };
  let parsed: RecoverSpec;
  try {
    parsed = parseRecoverSpec(spec);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }
  out.provider = parsed.provider;
  out.asked = parsed.ids.length;
  const cfg = active.find((p) => p.id === parsed.provider);
  if (!cfg) {
    out.error = `recover: ${parsed.provider} is not an active source`;
    return out;
  }
  const reader = PAGE_READERS[parsed.provider]!;
  const fetchPage = deps.fetchPage ?? defaultFetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const held = heldIds(eventMap, parsed.provider);
  const started = now();
  let lastStart = -Infinity;
  for (const [i, id] of parsed.ids.entries()) {
    let body: string | null = null;
    let lastErr = '';
    let tried = 0;
    let stopped = false;
    for (let attempt = 0; attempt < RECOVER_ATTEMPTS && body == null; attempt++) {
      const wait = lastStart + RECOVER_SPACING_MS - now();
      if (wait > 0) await sleep(wait);
      if (now() - started > RECOVER_DEADLINE_MS) {
        stopped = true;
        break;
      }
      lastStart = now();
      tried++;
      try {
        body = await fetchPage(reader.url(cfg, id), cfg);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (body == null) {
      if (tried) out.failed.push(`${id}: ${lastErr}`);
      else out.unasked.push(id);
      if (stopped) {
        out.unasked.push(...parsed.ids.slice(i + 1));
        break;
      }
      continue;
    }
    const row = reader.row(body, id);
    const report = row ? reader.parse({ events: [row] }, cfg.id)[0] : undefined;
    if (!report) {
      out.empty.push(id);
      continue;
    }
    const old = reader.oldNames(report).find((n) => held.has(`${cfg.id}:${n}`));
    if (old && !held.has(`${cfg.id}:${report.providerEventId}`)) {
      out.held_as.push(`${id}=${old}`);
      continue;
    }
    // One identity window of margin above the hot floor, as for a late ComCat mint (Resolver.reviseOrMintInHotWindow):
    // only events at or above the floor are in the space index, so a partner just below it would be missed.
    if (report.eventTimeMs < hotFloorMs + TEMPORAL_MS) {
      out.outside_window.push(`${id}@${isoFromMs(report.eventTimeMs)}`);
      continue;
    }
    out.rows.push(report);
    out.pages.set(report, reader.url(cfg, id));
  }
  return out;
}

/** The `reason` on a recovered report's op:observe line, so the log itself tells it from a live one. */
export const recoveredReason = (page: string, lagDays: number): string =>
  `recovered from the provider's event page ${page}, ${lagDays.toFixed(1)} d after origin (no longer in its rolling file)`;

/** What status.json keeps of an outcome: the ids, not the reports. */
export function recoverStatus(o: RecoverOutcome): Record<string, unknown> {
  const { pages: _pages, rows, ...rest } = o;
  return { ...rest, rows: rows.map((r) => r.providerEventId) };
}

/** The run's log line for an outcome. */
export function recoverSummary(o: RecoverOutcome): string {
  const list = (name: string, xs: string[]): string => (xs.length ? ` ${name}=[${xs.join(', ')}]` : '');
  return (
    `recover ${o.provider ?? '?'}: asked=${o.asked} rows=${o.rows.length}` +
    list('empty', o.empty) +
    list('held_as', o.held_as) +
    list('outside_window', o.outside_window) +
    list('failed', o.failed) +
    list('unasked', o.unasked) +
    (o.error ? ` error=${o.error}` : '')
  );
}
