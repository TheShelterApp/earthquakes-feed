import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AGENCY_PAIRS,
  AGING_CHECK,
  BOARD_LABEL,
  BOARDS,
  CHECKS,
  CLASSES,
  EVALUATORS,
  FINDINGS_SCHEMA,
  HC_PING_BASE,
  HEALTH_FALLBACK_CRON,
  INHIBITIONS,
  LIVENESS_CHECK,
  MAX_TEXT_CHARS,
  NEVER_RED_CLASSES,
  P2_RED_MS,
  PUSH_PRIORITY,
  RULES,
  SCHEDULE_SKIP_MS,
  SELFTEST_CHECK,
  SEVERITIES,
  STATE_MARKER,
  VERDICT_CHECKS,
  ageText,
  checkFor,
  findingsDocument,
  makeFinding,
  matchesKey,
  mayTurnRed,
  moreSevere,
  oneLine,
  parseFindingsDocument,
  ruleJudgesKey,
  ruleOf,
  severityRank,
  utcText,
  validateFinding,
  worstSeverity,
  type Finding,
  type RuleId,
} from '../scripts/lib/findings.mjs';

// The health findings shape and rule table (scripts/lib/findings.mjs): the alerting plan of 2026-10-22, section 3, with
// the owner's decisions of that day. Nothing here touches the network.

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ids = Object.keys(RULES) as RuleId[];
const limits = (id: RuleId): Record<string, any> => RULES[id].limits as Record<string, any>;

test('enums: severities most severe first, the three board titles, the classes and the checks', () => {
  assert.deepEqual([...SEVERITIES], ['P1', 'P2', 'P3', 'P4']);
  assert.deepEqual({ ...BOARDS }, { alerts: '[health] alert pipeline', feed: '[health] feed', platform: '[health] platform' });
  assert.equal(BOARD_LABEL, 'health-board');
  assert.deepEqual([...EVALUATORS], ['alerts', 'feed', 'platform']);
  assert.deepEqual([...CLASSES], ['symptom', 'redundancy', 'external', 'capacity', 'expiry', 'config', 'maintenance', 'watcher', 'unknown']);
  assert.deepEqual([...NEVER_RED_CLASSES], ['external', 'maintenance', 'watcher']);
  for (const c of NEVER_RED_CLASSES) assert.ok(CLASSES.includes(c));
  assert.deepEqual([...VERDICT_CHECKS], ['gh-detect', 'gh-deliver', 'gh-redundancy', 'gh-feed', 'gh-platform', 'gh-capacity']);
  assert.deepEqual([...CHECKS], [LIVENESS_CHECK, ...VERDICT_CHECKS, AGING_CHECK, SELFTEST_CHECK]);
  assert.equal(new Set(CHECKS).size, CHECKS.length);
  assert.equal(HC_PING_BASE, 'https://hc-ping.com');
  assert.equal(FINDINGS_SCHEMA, 'health-findings/1');
  assert.equal(STATE_MARKER, 'health-state v1');
});

test('owner decisions 2026-10-22: P2 pushes would bypass quiet hours, P2 is red for its first hour, writers are not judged', () => {
  assert.deepEqual({ ...PUSH_PRIORITY }, { P1: 2, P2: 1 });
  assert.equal(P2_RED_MS, HOUR);
  // Transient aggregate/derive publish failures stay red runs: no rule judges the writer workflows.
  assert.ok(ids.every((id) => !id.startsWith('writer')));
  // Single external-source outages are never red. alerts:provider:unlisted is the gateway's own configuration (a
  // direct provider it no longer polls), a P3 that the coverage rows back up.
  for (const id of ids) if (id.startsWith('alerts:provider:') && id !== 'alerts:provider:feed' && id !== 'alerts:provider:unlisted') assert.equal(RULES[id].class, 'external', id);
  assert.deepEqual([RULES['alerts:provider:unlisted'].class, RULES['alerts:provider:unlisted'].severity, RULES['alerts:provider:unlisted'].confirmRuns], ['config', 'P3', 2]);
  for (const id of ids) if (id.startsWith('feed:source')) assert.equal(RULES[id].class, 'external', id);
  assert.equal(mayTurnRed('external'), false);
  assert.equal(mayTurnRed('maintenance'), false);
  assert.equal(mayTurnRed('watcher'), false);
  assert.equal(mayTurnRed('symptom'), true);
  assert.equal(mayTurnRed('unknown'), true);
  // Shadow only: the canary, the watermark-age and the latency rules (owner), and feed:systemic (the plan).
  assert.deepEqual(ids.filter((id) => RULES[id].shadow).sort(), ['alerts:canary', 'alerts:latency', 'alerts:provider-silent', 'feed:systemic']);
  // The fallback cron skips when a dispatched run was created in the last 20 min.
  assert.equal(HEALTH_FALLBACK_CRON, '25 * * * *');
  assert.equal(SCHEDULE_SKIP_MS, 20 * MIN);
});

test('RULES: every entry is well formed and consistent with its board', () => {
  const boardOf = (key: string): string => (key.startsWith('alerts:') ? 'alerts' : key.startsWith('feed:') || key.startsWith('walks:') ? 'feed' : 'platform');
  for (const id of ids) {
    const r = RULES[id];
    assert.equal(r.id, id);
    assert.ok(r.title && r.title.length < 60, `${id}: title`);
    assert.ok(Object.hasOwn(BOARDS, r.board), `${id}: board`);
    assert.ok(CLASSES.includes(r.class), `${id}: class`);
    assert.ok(SEVERITIES.includes(r.severity), `${id}: severity`);
    assert.ok((r.key === null) !== (r.keyPrefix === null), `${id}: exactly one of key and keyPrefix`);
    const k = r.key ?? r.keyPrefix!;
    assert.equal(boardOf(k), r.board, `${id}: key ${k} on board ${r.board}`);
    if (r.keyPrefix !== null) assert.ok(r.keyPrefix.endsWith(':'), `${id}: keyPrefix ends with ':'`);
    if (typeof r.check === 'string') assert.ok(CHECKS.includes(r.check), `${id}: check`);
    else if (r.check !== null) for (const c of Object.values(r.check)) assert.ok(CHECKS.includes(c!), `${id}: check`);
    assert.ok(r.phase === 1 || r.phase === 2, `${id}: phase`);
    for (const n of [r.confirmRuns, r.resolveRuns, r.resolveRunsAfterRatio]) assert.ok(Number.isInteger(n) && n >= 1, `${id}: runs`);
    assert.ok(r.resolveRunsAfterRatio >= r.resolveRuns, `${id}: resolveRunsAfterRatio`);
    for (const n of [r.holdMs, r.resolveAfterMs]) assert.ok(Number.isFinite(n) && n >= 0, `${id}: ms`);
    assert.ok(r.escalateAfterMs === null || r.escalateAfterMs > 0, `${id}: escalateAfterMs`);
    if (r.promote) {
      assert.ok(r.promote.afterMs > 0 && moreSevere(r.promote.to, r.severity), `${id}: promote`);
      assert.ok(checkFor(r, r.promote.to), `${id}: a promoted entry pings a check`);
      assert.ok(Object.isFrozen(r.promote), `${id}: promote frozen`);
    }
    if (r.ratio) assert.ok(r.ratio.min >= 1 && r.ratio.min <= r.ratio.of && SEVERITIES.includes(r.ratio.severity), `${id}: ratio`);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.limits), `${id}: frozen`);
  }
  assert.ok(Object.isFrozen(RULES));
  assert.throws(() => {
    (limits('alerts:budget')['caps'] as Record<string, number>)['doRequests'] = 1;
  }, TypeError);
  // Phase 2 (the plan's star): only the rules that need a gateway field not published yet.
  assert.deepEqual(ids.filter((id) => RULES[id].phase === 2).sort(), ['alerts:dispatch', 'alerts:fanout']);
});

test('RULES: every key of the plan\'s section 3 has a rule, on the right board', () => {
  const keys: Array<[string, string]> = [
    ['alerts:status:stale', 'alerts'], ['alerts:status:unreadable', 'alerts'], ['alerts:coverage:all', 'alerts'], ['alerts:coverage:two', 'alerts'],
    ['alerts:provider:gfz', 'alerts'], ['alerts:provider:emsc', 'alerts'], ['alerts:provider:usgs', 'alerts'], ['alerts:usgs:primary', 'alerts'],
    ['alerts:usgs:deletions', 'alerts'], ['alerts:provider:feed', 'alerts'], ['alerts:provider-silent:gfz', 'alerts'], ['alerts:latency:emsc', 'alerts'],
    ['alerts:budget', 'alerts'], ['alerts:degraded', 'alerts'], ['alerts:policy', 'alerts'], ['alerts:apns', 'alerts'], ['alerts:dispatch', 'alerts'],
    ['alerts:fanout', 'alerts'], ['alerts:canary', 'alerts'],
    ['feed:freshness', 'feed'], ['feed:systemic', 'feed'], ['feed:status', 'feed'], ['feed:source:tmd', 'feed'], ['feed:cert:phivolcs', 'feed'],
    ['feed:size', 'feed'], ['feed:repo-size', 'feed'], ['walks:history:emsc', 'feed'],
    ['platform:api', 'platform'], ['platform:config-worker', 'platform'], ['config:bundle', 'platform'], ['platform:cf-usage', 'platform'],
    ['watcher:alerts-watchdog', 'platform'],
  ];
  for (const [key, board] of keys) {
    const judges = ids.filter((id) => ruleJudgesKey(RULES[id], key));
    assert.ok(judges.length > 0, `no rule judges ${key}`);
    for (const id of judges) assert.equal(RULES[id].board, board, `${id} judges ${key}`);
  }
  // One key, several rules: the board keeps one row per key.
  const judgesOf = (key: string): string[] => ids.filter((id) => ruleJudgesKey(RULES[id], key)).sort();
  assert.deepEqual(judgesOf('feed:freshness'), ['feed:freshness', 'feed:freshness:unreachable']);
  assert.deepEqual(judgesOf('config:bundle'), ['config:bundle:age', 'config:bundle:gap']);
  assert.deepEqual(judgesOf('alerts:provider:gfz'), ['alerts:provider:fast', 'alerts:provider:fast:invalid', 'alerts:provider:unlisted']);
  assert.deepEqual(judgesOf('feed:source:tmd'), ['feed:source', 'feed:source:core', 'feed:source:definite', 'feed:source:quiet']);
  // alerts:provider:usgs and :feed are single-key rules, also covered by the fast rules' prefix: an evaluator names the
  // rule, so the overlap is harmless, but the fast rules' ids are the two that poll every tick.
  assert.deepEqual(limits('alerts:provider:fast')['ids'], ['emsc', 'gfz']);
});

test('RULES: the alert-pipeline thresholds (section 3a as adjusted)', () => {
  assert.equal(limits('alerts:status:stale')['maxAgeMs'], 300 * SEC);
  assert.equal(RULES['alerts:status:stale'].severity, 'P1');
  assert.equal(RULES['alerts:status:stale'].check, 'gh-detect');
  const unreadable = RULES['alerts:status:unreadable'];
  assert.deepEqual([unreadable.severity, unreadable.confirmRuns, unreadable.check, unreadable.class], ['P2', 2, { P1: 'gh-detect', P2: 'gh-platform' }, 'unknown']);
  // Open for 60 min it is a P1 (decision 2026-10-22): every other alerts:* key is frozen meanwhile, so P1 detection is
  // blind. The only promotion; alerts:status:stale is a P1 already.
  assert.deepEqual({ ...unreadable.promote }, { afterMs: 60 * MIN, to: 'P1' });
  assert.deepEqual(ids.filter((id) => RULES[id].promote !== null), ['alerts:status:unreadable']);
  assert.equal(checkFor(unreadable, 'P2'), 'gh-platform');
  assert.equal(checkFor(unreadable, 'P1'), 'gh-detect');
  assert.deepEqual([limits('alerts:status:unreadable')['attempts'], limits('alerts:status:unreadable')['withinMs']], [3, 60 * SEC]);
  assert.deepEqual([RULES['alerts:coverage:all'].severity, limits('alerts:coverage:all')['minTogetherMs'], RULES['alerts:coverage:all'].resolveRuns], ['P1', 60 * SEC, 1]);
  assert.deepEqual([RULES['alerts:coverage:two'].severity, limits('alerts:coverage:two')['minTogetherMs'], RULES['alerts:coverage:two'].resolveRuns], ['P2', 180 * SEC, 2]);
  for (const id of ['alerts:provider:fast', 'alerts:provider:fast:invalid', 'alerts:provider:usgs'] as const) {
    const r = RULES[id];
    assert.deepEqual({ ...r.ratio }, { min: 4, of: 8, severity: 'P3' }, id);
    assert.deepEqual([r.severity, r.resolveRuns, r.resolveRunsAfterRatio, r.check], ['P3', 2, 4, null], id);
  }
  assert.deepEqual([limits('alerts:provider:fast')['lineMs'], RULES['alerts:provider:fast'].escalateAfterMs], [60 * MIN, 12 * HOUR]);
  assert.deepEqual(limits('alerts:provider:fast')['errors'], ['timeout', 'network', 'http']);
  assert.deepEqual([limits('alerts:provider:fast:invalid')['lineMs'], RULES['alerts:provider:fast:invalid'].escalateAfterMs], [15 * MIN, 2 * HOUR]);
  assert.deepEqual(limits('alerts:provider:fast:invalid')['errors'], ['invalid']);
  assert.deepEqual([limits('alerts:provider:usgs')['lineMs'], RULES['alerts:provider:usgs'].escalateAfterMs], [30 * MIN, 2 * HOUR]);
  assert.deepEqual([limits('alerts:usgs:primary')['lineMs'], RULES['alerts:usgs:primary'].escalateAfterMs], [6 * HOUR, null]);
  assert.deepEqual([limits('alerts:usgs:deletions')['lineMs'], RULES['alerts:usgs:deletions'].escalateAfterMs], [24 * HOUR, 5 * DAY]);
  assert.equal(limits('alerts:provider:feed')['lineMs'], 30 * MIN);
  assert.deepEqual(limits('alerts:provider-silent')['watermarkMaxAgeMs'], { usgs: 3 * HOUR, emsc: 3 * HOUR, gfz: 12 * HOUR });
  assert.equal(limits('alerts:latency')['maxLatencyMs'], 3_000);
  assert.deepEqual({ ...RULES['alerts:latency'].ratio }, { min: 4, of: 8, severity: 'P4' });
  const budget = limits('alerts:budget');
  assert.deepEqual([budget['enterShare'], budget['resolveShare'], budget['projectFromMs'], RULES['alerts:budget'].check], [0.75, 0.65, 2 * HOUR, 'gh-capacity']);
  assert.deepEqual(budget['caps'], { doRequests: 100_000, d1Reads: 5_000_000, doRowsRead: 5_000_000, doRowsWritten: 100_000, doGbSec: 13_000 });
  for (const id of ['alerts:degraded', 'alerts:policy', 'alerts:apns'] as const) assert.deepEqual([RULES[id].severity, RULES[id].check], ['P1', 'gh-deliver'], id);
  const canary = limits('alerts:canary');
  assert.deepEqual([canary['minEventAgeMs'], canary['maxEventAgeMs'], RULES['alerts:canary'].severity], [10 * MIN, 60 * MIN, 'P4']);
  assert.match(canary['url'], /^https:\/\/earthquake\.usgs\.gov\/earthquakes\/feed\/v1\.0\/summary\/4\.5_hour\.geojson$/);
  assert.deepEqual([limits('alerts:dispatch')['maxOldestAgeMs'], limits('alerts:dispatch')['maxFailedTicks'], limits('alerts:dispatch')['resolveOldestAgeMs']], [120 * SEC, 4, 30 * SEC]);
  assert.deepEqual([limits('alerts:fanout')['maxFailedShare'], limits('alerts:fanout')['minTargets']], [0.2, 10]);
  assert.deepEqual([RULES['alerts:selftest'].severity, RULES['alerts:selftest'].check], ['P1', 'selftest']);
});

test('RULES: the feed thresholds (section 3b)', () => {
  assert.deepEqual([RULES['feed:freshness'].severity, RULES['feed:freshness'].check, RULES['feed:freshness'].confirmRuns], ['P2', 'gh-feed', 1]);
  assert.deepEqual([limits('feed:freshness')['defaultStaleAfterMs'], limits('feed:freshness')['reReadAfterMs'], limits('feed:freshness')['queueReReadMs']], [1_800 * SEC, 60 * SEC, 600 * SEC]);
  assert.deepEqual([RULES['feed:freshness:unreachable'].key, RULES['feed:freshness:unreachable'].confirmRuns, RULES['feed:freshness:unreachable'].severity], ['feed:freshness', 2, 'P2']);
  const systemic = limits('feed:systemic');
  assert.deepEqual([systemic['coreIds'], systemic['coreMin'], systemic['anyMin'], systemic['continuousMs'], RULES['feed:systemic'].resolveAfterMs], [['usgs', 'emsc', 'geofon'], 2, 6, 30 * MIN, 30 * MIN]);
  assert.deepEqual([RULES['feed:status'].severity, RULES['feed:status'].confirmRuns], ['P3', 2]);
  assert.deepEqual([limits('feed:source')['lineMs'], RULES['feed:source'].escalateAfterMs, limits('feed:source')['resolveWithinMs']], [12 * HOUR, null, 30 * MIN]);
  assert.deepEqual([limits('feed:source:core')['lineMs'], RULES['feed:source:core'].escalateAfterMs, limits('feed:source:core')['ids']], [3 * HOUR, 24 * HOUR, ['usgs', 'emsc', 'geofon']]);
  const definite = limits('feed:source:definite');
  assert.deepEqual([definite['lineMs'], RULES['feed:source:definite'].escalateAfterMs, definite['httpStatuses'], definite['errorKinds']], [2 * HOUR, 24 * HOUR, [401, 403, 404, 410], ['schema']]);
  // A leaf enters at 7 days left (sinceMs = notAfter - 7 d) and escalates 5 days later, at 2 days left.
  assert.deepEqual([limits('feed:cert')['leafLineMs'], RULES['feed:cert'].escalateAfterMs], [7 * DAY, 5 * DAY]);
  assert.deepEqual([limits('feed:size')['dayFileBytes'], limits('feed:size')['fileBytes'], limits('feed:repo-size')['maxKb']], [5_000_000, 45_000_000, 8_000_000]);
  assert.deepEqual([limits('walks')['workflows'], limits('walks')['artifactPrefix'], limits('walks')['markerHoldMs'], RULES['walks'].class], [['history', 'first-solutions', 'backfill', 'archive'], 'walk-blocked-', 26 * HOUR, 'maintenance']);
  // The core feed sources are the gateway's three direct agencies, by their feed ids.
  assert.deepEqual([...limits('feed:source:core')['ids']].sort(), Object.values(AGENCY_PAIRS).sort());
});

test('RULES: the platform and config thresholds (section 3c)', () => {
  assert.deepEqual([RULES['platform:api'].severity, RULES['platform:api'].check, limits('platform:api')['attempts'], limits('platform:api')['spreadMs']], ['P2', 'gh-platform', 3, 60 * SEC]);
  assert.equal(RULES['platform:api:envelope'].severity, 'P3');
  assert.deepEqual([RULES['platform:config-worker'].severity, RULES['platform:config-worker'].escalateAfterMs], ['P3', 6 * HOUR]);
  const age = limits('config:bundle:age');
  assert.deepEqual([age['p3AgeMs'], age['p2AgeMs'], age['p1AgeMs'], age['expiresMs']], [5 * DAY, 10 * DAY, 25 * DAY, 30 * DAY]);
  assert.deepEqual([RULES['config:bundle:gap'].holdMs, RULES['config:bundle:gap'].severity], [24 * HOUR, 'P3']);
  const usage = limits('platform:cf-usage');
  assert.deepEqual([usage['p1ActualShare'], usage['p2ActualShare'], usage['p2ProjectedShare'], usage['resolveShare'], usage['projectFromMs']], [0.95, 0.8, 1, 0.7, 2 * HOUR]);
  assert.deepEqual(usage['caps'], { workersRequests: 100_000, d1RowsWritten: 100_000 });
  assert.deepEqual([RULES['watcher'].severity, RULES['watcher'].confirmRuns, RULES['watcher'].class, RULES['watcher'].board], ['P3', 2, 'watcher', 'platform']);
});

test('checkFor: a P1/P2 pings the rule\'s check; a per-severity check picks by severity; a P3/P4 pings nothing', () => {
  assert.equal(checkFor(RULES['alerts:status:stale'], 'P1'), 'gh-detect');
  assert.equal(checkFor(RULES['alerts:degraded'], 'P3'), null); // forced: a reminder
  assert.equal(checkFor(RULES['alerts:apns'], 'P3'), null);
  assert.equal(checkFor(RULES['config:bundle:age'], 'P3'), null);
  assert.equal(checkFor(RULES['config:bundle:age'], 'P2'), 'gh-platform');
  assert.equal(checkFor(RULES['config:bundle:age'], 'P1'), 'gh-deliver');
  assert.equal(checkFor(RULES['platform:cf-usage'], 'P2'), 'gh-capacity');
  assert.equal(checkFor(RULES['platform:cf-usage'], 'P1'), 'gh-deliver');
  assert.equal(checkFor(RULES['alerts:provider:usgs'], 'P3'), null);
  assert.equal(checkFor(null, 'P1'), null);
});

test('makeFinding: board, class, shadow and check come from the rule; a member rule builds its key from the id', () => {
  const gfz = makeFinding('alerts:provider:fast', { id: 'gfz', sinceMs: 1, text: 'gfz failing for 61 min' });
  assert.deepEqual(gfz, { key: 'alerts:provider:gfz', rule: 'alerts:provider:fast', board: 'alerts', severity: 'P3', class: 'external', sinceMs: 1, text: 'gfz failing for 61 min', check: null, shadow: false });
  const sample = makeFinding('alerts:provider:fast', { id: 'gfz', severity: 'P4', text: 'gfz ok:false for 2 min' });
  assert.deepEqual([sample.severity, sample.sinceMs], ['P4', null]);
  const stale = makeFinding('alerts:status:stale', { sinceMs: 5, text: 'status.json is 615 s old' });
  assert.deepEqual([stale.key, stale.severity, stale.check], ['alerts:status:stale', 'P1', 'gh-detect']);
  const bundle = makeFinding('config:bundle:age', { severity: 'P1', text: 'the config bundle is 25.4 d old', members: ['age', 'gap'] });
  assert.deepEqual([bundle.key, bundle.check, bundle.members], ['config:bundle', 'gh-deliver', ['age', 'gap']]);
  const silent = makeFinding('alerts:provider-silent', { id: 'gfz', text: 'gfz watermark 13 h old' });
  assert.equal(silent.shadow, true);
  // An explicit check wins (null included); the text is one line, without backticks or control characters.
  assert.equal(makeFinding('alerts:degraded', { text: 'x', check: null }).check, null);
  assert.equal(makeFinding('feed:source', { id: 'tmd', text: 'tmd:\n `unable to verify`\u0007 the first certificate' }).text, 'tmd: unable to verify the first certificate');
  assert.equal(makeFinding('feed:source', { id: 'tmd', text: 'x'.repeat(2_000) }).text.length, MAX_TEXT_CHARS);
  // Every finding it builds validates; bad input throws instead of writing a document reconcile would reject.
  assert.deepEqual(validateFinding(gfz), []);
  assert.throws(() => makeFinding('nope' as RuleId, { text: 'x' }), /unknown rule/);
  assert.throws(() => makeFinding('feed:source', { text: 'no id' }), /does not judge key feed:source:/);
  assert.throws(() => makeFinding('alerts:policy', { text: '  ' }), /text is empty/);
  assert.throws(() => makeFinding('alerts:policy', { text: 'x', severity: 'P0' as 'P1' }), /bad severity/);
  assert.throws(() => makeFinding('alerts:policy', { key: 'alerts:apns', text: 'x' }), /does not judge key alerts:apns/);
  assert.throws(() => makeFinding('feed:source', { id: 'TMD', text: 'x' }), /bad key/);
  assert.equal(makeFinding('alerts:policy', { text: 'x', sinceMs: Number.NaN }).sinceMs, null);
});

test('validateFinding: a finding must agree with its rule', () => {
  const ok: Finding = makeFinding('feed:freshness:unreachable', { text: 'v2/manifest.json unreachable after 4 attempts' });
  assert.equal(ok.key, 'feed:freshness');
  assert.deepEqual(validateFinding(ok), []);
  const bad = (patch: Record<string, unknown>): string[] => validateFinding({ ...ok, ...patch });
  assert.match(bad({ board: 'alerts' }).join(), /board alerts is not rule feed:freshness:unreachable's/);
  assert.match(bad({ class: 'symptom' }).join(), /class symptom is not rule/);
  assert.match(bad({ shadow: true }).join(), /shadow true is not rule/);
  assert.match(bad({ rule: 'feed:nope' }).join(), /unknown rule/);
  assert.match(bad({ key: 'feed:size' }).join(), /does not judge key feed:size/);
  assert.match(bad({ sinceMs: '1' }).join(), /sinceMs/);
  assert.match(bad({ check: 'gw-detect' }).join(), /bad check/);
  assert.match(bad({ members: [1] }).join(), /members/);
  assert.match(bad({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }).join(), /text/);
  assert.deepEqual(validateFinding(null), ['not an object']);
  assert.deepEqual(validateFinding([]), ['not an object']);
});

test('findingsDocument / parseFindingsDocument: a JSON round trip; one bad finding rejects the whole document', () => {
  const findings = [
    makeFinding('alerts:provider:fast', { id: 'gfz', severity: 'P4', sinceMs: 1_790_000_000_000, text: 'gfz ok:false for 2 min' }),
    makeFinding('alerts:coverage:two', { severity: 'P4', text: 'gfz and emsc failing together for 40 s', members: ['gfz', 'emsc'] }),
  ];
  const doc = findingsDocument({ evaluator: 'alerts', generatedAtMs: 1_790_000_060_000, findings, unjudged: ['platform:cf-usage'], notes: ['policy=signed/v19'] });
  assert.deepEqual(Object.keys(doc), ['schema', 'evaluator', 'generatedAtMs', 'findings', 'unjudged', 'notes']);
  const parsed = parseFindingsDocument(JSON.parse(JSON.stringify(doc)));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.doc, doc);
  const reject = (patch: Record<string, unknown>): string => {
    const r = parseFindingsDocument({ ...doc, ...patch });
    assert.equal(r.ok, false);
    return (r as { error: string }).error;
  };
  assert.match(reject({ schema: 'health-findings/2' }), /schema/);
  assert.match(reject({ evaluator: 'heartbeat' }), /unknown evaluator/);
  assert.match(reject({ generatedAtMs: '2026-10-22' }), /generatedAtMs/);
  assert.match(reject({ findings: {} }), /findings is not a list/);
  assert.match(reject({ findings: [findings[0], { ...findings[1], severity: 'P5' }] }), /^finding 1 \(alerts:coverage:two\): bad severity/);
  assert.match(reject({ unjudged: [1] }), /unjudged/);
  assert.match(reject({ notes: null }), /notes/);
  assert.equal(parseFindingsDocument('{}').ok, false);
  assert.throws(() => findingsDocument({ evaluator: 'feed', generatedAtMs: 1, findings: [{ ...findings[0]!, board: 'feed' }] }), /findingsDocument: finding 0/);
});

test('ageText rounds down at every unit, so a span short of a line never reads as the line', () => {
  const cases: Array<[number, string]> = [
    [0, '0 s'], [-5_000, '0 s'], [59_999, '59 s'], [119_999, '119 s'], [120_000, '2 min'], [209_999, '3 min'], [210_000, '3.5 min'],
    [3_599_999, '59.5 min'], [7_199_999, '119.5 min'], [7_200_000, '2.0 h'], [9_360_000, '2.6 h'], [10_799_999, '2.9 h'],
    [172_799_999, '47.9 h'], [172_800_000, '2.0 d'], [380_160_000, '4.4 d'], [25 * DAY, '25.0 d'],
  ];
  for (const [ms, text] of cases) assert.equal(ageText(ms), text, String(ms));
  assert.equal(ageText(Number.NaN), '?');
  assert.equal(ageText(null), '?');
});

test('utcText and oneLine', () => {
  assert.equal(utcText(Date.parse('2026-10-21T12:50:31.512Z')), '2026-10-21 12:50Z');
  assert.equal(utcText(null), '?');
  assert.equal(utcText(Number.POSITIVE_INFINITY), '?');
  assert.equal(utcText(8.64e15 + 1), '?');
  assert.equal(oneLine('  a;\tb\r\n`c`  '), 'a; b c');
  assert.equal(oneLine(null), '');
  assert.equal(oneLine({ toString: () => 'obj' }), 'obj');
  assert.equal(oneLine('abcdef', 4), 'abc…');
  assert.equal(oneLine('abcd', 4), 'abcd');
});

test('severity helpers', () => {
  assert.deepEqual(SEVERITIES.map(severityRank), [1, 2, 3, 4]);
  assert.equal(severityRank('P0'), Infinity);
  assert.equal(moreSevere('P1', 'P2'), true);
  assert.equal(moreSevere('P3', 'P3'), false);
  assert.equal(moreSevere('P4', undefined), true);
  assert.equal(worstSeverity('P3', 'P1', 'P4'), 'P1');
  assert.equal(worstSeverity(), 'P4');
  assert.equal(worstSeverity(null, undefined, 'P3'), 'P3');
});

test('matchesKey, ruleJudgesKey and ruleOf', () => {
  assert.equal(matchesKey('feed:source:*', 'feed:source:tmd'), true);
  assert.equal(matchesKey('feed:source:*', 'feed:sources'), false);
  assert.equal(matchesKey('alerts:provider:feed', 'alerts:provider:feed'), true);
  assert.equal(matchesKey('alerts:provider:feed', 'alerts:provider:feeds'), false);
  assert.equal(matchesKey('*', 'anything'), true);
  assert.equal(ruleJudgesKey(RULES['feed:source'], 'feed:source:'), false);
  assert.equal(ruleJudgesKey(RULES['walks'], 'walks:first-solutions:emsc'), true);
  assert.equal(ruleJudgesKey(RULES['alerts:budget'], 'alerts:budget:x'), false);
  assert.equal(ruleOf({ rule: 'feed:size' }), RULES['feed:size']);
  assert.equal(ruleOf({ rule: 'toString' }), null);
  assert.equal(ruleOf(null), null);
});

test('inhibition: a stale feed mutes the feed sources and the gateway backstop; an agency down in the gateway mutes its feed twin', () => {
  const muted = (when: string, key: string): boolean => INHIBITIONS.some((i) => matchesKey(i.when, when) && (i.mute ?? []).some((p) => matchesKey(p, key)));
  assert.equal(muted('feed:freshness', 'feed:source:tmd'), true);
  assert.equal(muted('feed:freshness', 'alerts:provider:feed'), true);
  assert.equal(muted('feed:freshness', 'feed:cert:tmd'), false);
  assert.equal(muted('alerts:provider:gfz', 'feed:source:geofon'), true);
  assert.equal(muted('alerts:provider:usgs', 'feed:source:usgs'), true);
  assert.equal(muted('alerts:provider:emsc', 'feed:source:emsc'), true);
  assert.equal(muted('alerts:provider:gfz', 'feed:source:emsc'), false);
  // A coverage finding mutes the providers it names as members.
  const coverage = INHIBITIONS.find((i) => i.muteMembers);
  assert.deepEqual([coverage?.when, coverage?.muteMembers], ['alerts:coverage:*', 'alerts:provider:']);
  assert.equal(matchesKey(coverage!.when, 'alerts:coverage:two'), true);
});

// The budget caps mirror the gateway's FREE_TIER. When a platform checkout is at hand (SHELTER_PLATFORM_DIR, or the
// sibling ../platform of a local clone), compare them with it; CI has none and skips.
const platformDir = process.env.SHELTER_PLATFORM_DIR ?? join(import.meta.dirname, '..', '..', 'platform');
const budgetSrc = join(platformDir, 'services', 'alerts-gateway', 'src', 'status', 'budget.ts');
test('alerts:budget caps match the alerts-gateway FREE_TIER', { skip: existsSync(budgetSrc) ? false : 'no platform checkout' }, () => {
  const src = readFileSync(budgetSrc, 'utf8');
  const block = /export const FREE_TIER: FreeTierLimits = \{([^}]*)\}/.exec(src)?.[1] ?? '';
  const n = (name: string): number => Number(new RegExp(`${name}: ([\\d_]+)`).exec(block)![1]!.replace(/_/g, ''));
  assert.deepEqual(limits('alerts:budget')['caps'], {
    doRequests: n('doRequestsPerDay'),
    d1Reads: n('d1ReadsPerDay'),
    doRowsRead: n('doRowsReadPerDay'),
    doRowsWritten: n('doRowsWrittenPerDay'),
    doGbSec: n('doGbSecPerDay'),
  });
});
