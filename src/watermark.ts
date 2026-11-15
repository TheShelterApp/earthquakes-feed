/** How far past the run clock a provider's update stamp may lie before it is ignored as a watermark. */
export const WATERMARK_SKEW_MS = 3_600_000;

/**
 * The monotonic per-provider watermark after one more report. A stamp in the future (IPMA once published
 * 2099-12-31) must not pin it for good: such a stamp is ignored, and so is a stored watermark an earlier run took from one.
 */
export function advanceWatermark(prior: number | undefined, stamp: number, nowMs: number): number {
  const ceiling = nowMs + WATERMARK_SKEW_MS;
  const base = prior !== undefined && prior <= ceiling ? prior : 0;
  return stamp <= ceiling ? Math.max(base, stamp) : base;
}
