import { ABSENCE_WATCH_DAYS, ABSENCE_WATCH_PROVIDERS } from './config.js';
import type { FetchOutcome } from './providers.js';
import type { EventNode } from './types.js';

/** How many ids status lists per provider (the count is complete). */
const MAX_LISTED = 20;

export interface Absence {
  /** Live rows younger than the watch window whose id the provider's complete file no longer lists. */
  count: number;
  /** The first MAX_LISTED of them, sorted. */
  ids: string[];
}

/**
 * PF-5b, log only: for each rolling-file source in ABSENCE_WATCH_PROVIDERS whose fetch succeeded this run, the rows
 * the feed holds live with an origin younger than ABSENCE_WATCH_DAYS that the file no longer lists. AEC's file spans
 * ~14 days, so a younger id that vanished was most likely deleted upstream (the file carries no delete marker).
 * Nothing is retracted: aggregate records the counts in status `absent`, and whether absence should retract is
 * decided after a week of them. A failed fetch says nothing, so its source is left out.
 */
export function vanishedIds(
  eventMap: Map<string, EventNode>,
  outcomes: readonly FetchOutcome[],
  nowMs: number,
  providers: readonly string[] = ABSENCE_WATCH_PROVIDERS,
  days: number = ABSENCE_WATCH_DAYS,
): Record<string, Absence> {
  const out: Record<string, Absence> = {};
  const floor = nowMs - days * 86_400_000;
  for (const p of providers) {
    const o = outcomes.find((x) => x.provider === p);
    if (!o?.status.ok) continue;
    const listed = new Set(o.obs.map((r) => r.providerEventId));
    const gone: string[] = [];
    for (const n of eventMap.values()) {
      if (n.state !== 'live') continue;
      for (const r of n.provenance) if (r.provider === p && r.eventTimeMs >= floor && !listed.has(r.nativeId)) gone.push(r.nativeId);
    }
    gone.sort();
    out[p] = { count: gone.length, ids: gone.slice(0, MAX_LISTED) };
  }
  return out;
}
