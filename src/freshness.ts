// The freshness thresholds published in status.json and the v1 manifest. Kept in one place so the
// two documents never drift (STOP-4: the client derives its DataFreshness only from these).
export const FRESHNESS_EXPECTED_INTERVAL_SECONDS = 300;
export const FRESHNESS_STALE_AFTER_SECONDS = 1800;
