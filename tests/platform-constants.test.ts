import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BACKSTOP_PROVIDER,
  DELETIONS_MAX_WINDOW_MS,
  DIRECT_PROVIDERS,
  GATEWAY_TICK_MS,
  isFastProvider,
  PROVIDER_BACKOFF_STEPS,
  PROVIDER_MIN_INTERVAL_MS,
} from '../scripts/alerts-watchdog.mjs';
import { RULES } from '../scripts/lib/findings.mjs';

// The alerts-gateway constants the health evaluators mirror (the detector's polling cadence that turns a failure count
// into a duration, its direct providers and backstop, the USGS deletions window, the free-tier caps of alerts:budget).
// CI has no platform checkout, so a source comparison alone would skip there and never run: the mirrors are checked
// against a committed snapshot (tests/fixtures/platform-constants.json, with the platform commit it was read from) on
// every run, and the snapshot against the gateway's source when a checkout is at hand (SHELTER_PLATFORM_DIR, or the
// sibling ../platform of a local clone, ~/Developer/TheShelter/platform).

interface Snapshot {
  platform: { repository: string; commit: string; readOn: string; root: string };
  constants: Record<string, { source: string; value: unknown }>;
}
const SNAPSHOT: Snapshot = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'platform-constants.json'), 'utf8'));
const value = (name: string): any => {
  assert.ok(Object.hasOwn(SNAPSHOT.constants, name), `the snapshot has ${name}`);
  return SNAPSHOT.constants[name]!.value;
};
/** alerts:budget's caps by status.json budget field, and the FREE_TIER name of each. */
const BUDGET_FIELDS: Record<string, string> = {
  doRequests: 'doRequestsPerDay',
  d1Reads: 'd1ReadsPerDay',
  doRowsRead: 'doRowsReadPerDay',
  doRowsWritten: 'doRowsWrittenPerDay',
  doGbSec: 'doGbSecPerDay',
};

test('platform constants: the snapshot names the platform commit and the source of every value', () => {
  assert.equal(SNAPSHOT.platform.repository, 'gitlab.com/the-shelter/platform');
  assert.match(SNAPSHOT.platform.commit, /^[0-9a-f]{40}$/);
  assert.match(SNAPSHOT.platform.readOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(SNAPSHOT.platform.root, 'services/alerts-gateway/src');
  assert.deepEqual(Object.keys(SNAPSHOT.constants).sort(), ['backoffSteps', 'backstopProvider', 'deletionsMaxWindowMs', 'directProviders', 'freeTier', 'minIntervalMs', 'tickIntervalMs']);
  for (const [name, c] of Object.entries(SNAPSHOT.constants)) assert.match(c.source, /^[a-z-]+\/[a-z-]+\.ts /, name);
});

test('platform constants: the evaluators\' mirrors match the snapshot (every run, CI included)', () => {
  assert.equal(GATEWAY_TICK_MS, value('tickIntervalMs'));
  assert.deepEqual({ ...PROVIDER_MIN_INTERVAL_MS }, value('minIntervalMs'));
  assert.deepEqual(PROVIDER_BACKOFF_STEPS.map((s) => ({ ...s })), value('backoffSteps'));
  assert.deepEqual([...DIRECT_PROVIDERS], value('directProviders'));
  assert.equal(BACKSTOP_PROVIDER, value('backstopProvider'));
  assert.equal(DELETIONS_MAX_WINDOW_MS, value('deletionsMaxWindowMs'));
  const tier = value('freeTier') as Record<string, number>;
  assert.deepEqual(Object.values(BUDGET_FIELDS).sort(), Object.keys(tier).sort());
  assert.deepEqual(RULES['alerts:budget'].limits['caps'], Object.fromEntries(Object.entries(BUDGET_FIELDS).map(([field, name]) => [field, tier[name]])));
  // The rules that name providers name the gateway's: EMSC and GFZ are the direct providers polled on every tick.
  assert.deepEqual(RULES['alerts:provider:fast'].limits['ids'], DIRECT_PROVIDERS.filter(isFastProvider));
  assert.deepEqual(RULES['alerts:provider:fast:invalid'].limits['ids'], DIRECT_PROVIDERS.filter(isFastProvider));
});

const platformDir = process.env.SHELTER_PLATFORM_DIR ?? join(import.meta.dirname, '..', '..', 'platform');
const gatewaySrc = join(platformDir, SNAPSHOT.platform.root);
test('platform constants: the snapshot matches the alerts-gateway source of a platform checkout', { skip: existsSync(gatewaySrc) ? false : 'no platform checkout: the snapshot stands in' }, () => {
  const read = (rel: string): string => readFileSync(join(gatewaySrc, rel), 'utf8');
  const num = (v: string): number => Number(v.replace(/_/g, ''));
  /** A numeric literal or a product of them ("5 * 60_000"). */
  const product = (v: string): number => v.split('*').reduce((n, f) => n * num(f.trim()), 1);
  const match = (re: RegExp, src: string, what: string): RegExpExecArray => {
    const m = re.exec(src);
    assert.ok(m, `${what} not found: the gateway's source moved (update this test and the snapshot)`);
    return m;
  };
  const changed = `the gateway changed since the snapshot of platform ${SNAPSHOT.platform.commit.slice(0, 10)}: update the evaluator's mirror, then tests/fixtures/platform-constants.json`;

  assert.equal(num(match(/const TICK_INTERVAL_MS = ([\d_]+)/, read('durable-objects/event-detector.ts'), 'TICK_INTERVAL_MS')[1]!), value('tickIntervalMs'), changed);

  const sources = read('detect/sources.ts');
  const feed = read('detect/feed-source.ts');
  const source = (name: string): { id: string; minIntervalMs: number } => {
    const m = match(new RegExp(`export const ${name}\\b[^]*?\\bid: '([a-z0-9_-]+)'[^]*?minIntervalMs: ([\\d_]+)`), sources, name);
    return { id: m[1]!, minIntervalMs: num(m[2]!) };
  };
  const all = match(/export const ALL_SOURCES[^=]*= \[([^\]]*)\]/, sources, 'ALL_SOURCES')[1]!.split(',').map((s) => s.trim()).filter(Boolean).map(source);
  assert.deepEqual(all.map((s) => s.id), value('directProviders'), changed);
  const backstop = match(/export function makeFeedSource[^]*?\bid: '([a-z0-9_-]+)'/, feed, 'makeFeedSource id')[1]!;
  assert.equal(backstop, value('backstopProvider'), changed);
  const min = Object.fromEntries([...all.map((s) => [s.id, s.minIntervalMs]), [backstop, num(match(/const MIN_INTERVAL_MS = ([\d_]+)/, feed, 'MIN_INTERVAL_MS')[1]!)]]);
  assert.deepEqual(min, value('minIntervalMs'), changed);

  const steps = [...read('detect/provider-health.ts').matchAll(/\{ atFailures: (\d+), intervalMs: ([\d_ *]+?) \}/g)].map((m) => ({ atFailures: Number(m[1]), intervalMs: product(m[2]!) }));
  assert.deepEqual(steps, value('backoffSteps'), changed);

  // USGS_DELETIONS_MAX_WINDOW_MS is AFTERSHOCK_WINDOW_MS (the detector's withdrawal floor), or a literal of its own.
  const deletions = match(/export const USGS_DELETIONS_MAX_WINDOW_MS = ([^\n]+)/, sources, 'USGS_DELETIONS_MAX_WINDOW_MS')[1]!.trim();
  const window = deletions === 'AFTERSHOCK_WINDOW_MS' ? match(/export const AFTERSHOCK_WINDOW_MS = ([\d_ *]+)/, read('fanout/aftershock.ts'), 'AFTERSHOCK_WINDOW_MS')[1]! : deletions;
  assert.equal(product(window), value('deletionsMaxWindowMs'), changed);

  const block = match(/export const FREE_TIER: FreeTierLimits = \{([^}]*)\}/, read('status/budget.ts'), 'FREE_TIER')[1]!;
  const tier = Object.fromEntries([...block.matchAll(/(\w+): ([\d_]+)/g)].map((m) => [m[1]!, num(m[2]!)]));
  assert.deepEqual(tier, value('freeTier'), changed);
});
