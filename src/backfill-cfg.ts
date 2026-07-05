import type { ProviderConfig } from './types.js';

export interface BackfillCfg {
  earliestMs: number;
  minmag?: number;
  maxWindowDays: number;
  initialWindowDays: number;
}

/** A provider is backfill/onboarding-eligible if it is FDSN or one of the time-range custom
 *  APIs (afad/kagsr), unless the registry explicitly disables it. Forward-only sources
 *  (no historical time-range API) return null — they can't be walked backward. */
export function backfillCfg(p: ProviderConfig): BackfillCfg | null {
  const eligible = p.adapter === 'fdsn' || p.id === 'afad' || p.id === 'kagsr';
  const enabled = p.backfill?.enabled ?? eligible;
  if (!enabled) return null;
  const isAfad = p.id === 'afad';
  return {
    earliestMs: Date.parse(`${p.backfill?.earliest ?? (isAfad ? '2015-01-01' : '1990-01-01')}T00:00:00Z`),
    minmag: p.backfill?.minmag,
    maxWindowDays: p.backfill?.maxWindowDays ?? (isAfad ? 7 : 30),
    initialWindowDays: p.backfill?.initialWindowDays ?? (isAfad ? 3 : 14),
  };
}
