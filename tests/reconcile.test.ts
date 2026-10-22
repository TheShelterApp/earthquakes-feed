import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateStatus } from '../scripts/alerts-watchdog.mjs';
import {
  EVALUATORS,
  HC_PING_BASE,
  HEALTH_FALLBACK_CRON,
  P2_RED_MS,
  SCHEDULE_SKIP_MS,
  findingsDocument,
  makeFinding,
  utcText,
  type Board,
  type Evaluator,
  type Finding,
  type FindingsDocument,
  type RuleId,
  type Severity,
} from '../scripts/lib/findings.mjs';
import {
  LABEL_DEFS,
  LOG_MAX_EVENTS,
  MAX_BODY_CHARS,
  MAX_SILENCES,
  SELFTEST_CRON,
  annotation,
  main,
  markdownText,
  parseArgs,
  parseBoardState,
  parseSilences,
  pingUrl,
  reconcile,
  renderBody,
  scheduleGate,
  type BoardState,
  type Entry,
  type FetchImpl,
  type ReconcileResult,
  type Silence,
} from '../scripts/reconcile.mjs';

// The single writer of the health boards (scripts/reconcile.mjs): the alerting plan of 2026-10-22, section 4 and Phase
// 1a item 5, with the owner's decisions of that day. Findings are hand-built with makeFinding/findingsDocument; health
// runs come every 15 min (:07/:22/:37/:52). Every run of the World below also checks that each body round-trips its
// state and stays under the size limit. Nothing here touches the network.

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T = (iso: string): number => Date.parse(iso);
const BOARD_IDS: Board[] = ['alerts', 'feed', 'platform'];
const REPO = 'TheShelterApp/earthquakes-feed';
const runUrl = (n: number): string => `https://github.com/${REPO}/actions/runs/${n}`;

type Findings = Partial<Record<Evaluator, Finding[] | null>>;
interface RunOpts {
  silences?: Silence[];
  eventName?: string;
  unjudged?: Partial<Record<Evaluator, string[]>>;
  generatedAtMs?: number;
  missing?: Partial<Record<Evaluator, string>>;
  pingsEnabled?: boolean;
}

/** A sequence of health runs whose state lives only in the rendered bodies, as on GitHub. */
class World {
  bodies: Record<Board, string | null> = { alerts: null, feed: null, platform: null };
  comments: Array<{ board: Board; body: string; at: string }> = [];
  lastDocs: FindingsDocument[] = [];
  n = 1000;

  prev(): Record<Board, BoardState | null> {
    return { alerts: parseBoardState(this.bodies.alerts, 'alerts'), feed: parseBoardState(this.bodies.feed, 'feed'), platform: parseBoardState(this.bodies.platform, 'platform') };
  }

  apply(nowMs: number, docs: unknown[], opts: RunOpts = {}): ReconcileResult {
    this.n += 1;
    const r = reconcile(this.prev(), docs, nowMs, opts.silences ?? [], {
      runId: String(this.n),
      runUrl: runUrl(this.n),
      eventName: opts.eventName ?? 'workflow_dispatch',
      existing: BOARD_IDS.filter((b) => this.bodies[b] !== null),
      missing: opts.missing ?? {},
      pingsEnabled: opts.pingsEnabled ?? false,
    });
    for (const b of BOARD_IDS) {
      const body = r.bodies[b];
      if (body === null) {
        assert.equal(r.state[b], null);
        assert.equal(this.bodies[b], null, `${b}: an existing board always gets a body`);
        continue;
      }
      assert.ok(body.length <= MAX_BODY_CHARS, `${b}: body of ${body.length} characters`);
      assert.deepEqual(parseBoardState(body, b), r.state[b], `${b}: the body round-trips its state`);
      this.bodies[b] = body;
    }
    assert.equal(new Set(r.comments.map((c) => c.board)).size, r.comments.length, 'at most one comment per board');
    for (const c of r.comments) this.comments.push({ ...c, at: utcText(nowMs) });
    return r;
  }

  docs(nowMs: number, findings: Findings, opts: RunOpts = {}): FindingsDocument[] {
    return EVALUATORS.filter((e) => findings[e] !== null).map((e) =>
      findingsDocument({ evaluator: e, generatedAtMs: opts.generatedAtMs ?? nowMs - 30 * SEC, findings: findings[e] ?? [], unjudged: opts.unjudged?.[e] ?? [] }),
    );
  }

  run(iso: string, findings: Findings = {}, opts: RunOpts = {}): ReconcileResult {
    const nowMs = T(iso);
    this.lastDocs = this.docs(nowMs, findings, opts);
    return this.apply(nowMs, this.lastDocs, opts);
  }

  state(b: Board): BoardState | null {
    return parseBoardState(this.bodies[b], b);
  }

  entry(key: string): Entry | undefined {
    for (const b of BOARD_IDS) {
      const e = this.state(b)?.entries[key];
      if (e) return e;
    }
    return undefined;
  }
}

/** ISO times every 15 min from `from` to `to`, both included. */
function every15(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = T(from); t <= T(to); t += 15 * MIN) out.push(new Date(t).toISOString());
  return out;
}

const signal = (r: ReconcileResult, check: string): string[] => r.pings.filter((p) => p.check === check).map((p) => p.signal);
const failing = (r: ReconcileResult): string[] => r.pings.filter((p) => p.signal === 'fail').map((p) => p.check);

const f = (rule: RuleId, fields: { id?: string; severity?: Severity; sinceMs?: number | null; text?: string; members?: string[] }): Finding =>
  makeFinding(rule, { ...fields, text: fields.text ?? `${rule}${fields.id ? ` ${fields.id}` : ''} (${fields.severity ?? 'rule severity'})` });
const gfz = (severity: Severity, sinceMs: number, rule: RuleId = 'alerts:provider:fast'): Finding => f(rule, { id: 'gfz', severity, sinceMs, text: `gfz failing (timeout) since ${utcText(sinceMs)}` });
const tmd = (severity: Severity = 'P3', sinceMs: number | null = T('2026-10-21T07:50:00Z')): Finding =>
  f('feed:source:definite', { id: 'tmd', severity, sinceMs, members: ['fetch'], text: 'tmd fetch failing: unable to verify the first certificate' });

// ---------------------------------------------------------------------------------------------------------
// Replays of past incidents

test('2026-10-21 GEOFON: P4 samples, enters by 4 of 8 at 13:37 (one comment), P3 by line at 13:52, resolves silently at 16:22', () => {
  const w = new World();
  const since = T('2026-10-21T12:50:00Z');
  for (const iso of every15('2026-10-21T12:52:00Z', '2026-10-21T15:22:00Z')) {
    const nowMs = T(iso);
    const r = w.run(iso, { alerts: [gfz(nowMs - since >= 60 * MIN ? 'P3' : 'P4', since)] });
    assert.equal(r.exitCode, 0, iso);
    assert.deepEqual(failing(r), [], `${iso}: every ping is a success`);
    const e = w.entry('alerts:provider:gfz')!;
    if (nowMs < T('2026-10-21T13:37:00Z')) {
      assert.equal(e.open, false, iso);
      assert.equal(r.comments.length, 0, iso);
    } else if (iso === '2026-10-21T13:37:00.000Z') {
      assert.equal(e.open, true);
      assert.equal(e.enteredBy, 'ratio');
      assert.equal(e.episodeSinceMs, since);
      assert.equal(e.severity, 'P3');
      assert.equal(r.comments.length, 1);
      assert.equal(r.comments[0]!.board, 'alerts');
      assert.match(r.comments[0]!.body, /^\*\*P3 · `alerts:provider:gfz`\*\* EMSC or GFZ failing — gfz failing \(timeout\) since 2026-10-21 12:50Z \(since 2026-10-21 12:50Z, 47 min; entered on 4 of the last 8 runs\)/);
      assert.match(r.comments[0]!.body, /\n\nRun: https:\/\/github\.com\/TheShelterApp\/earthquakes-feed\/actions\/runs\/\d+$/);
      assert.deepEqual(r.labels.alerts, ['health-board', 'health:p3']);
      assert.ok(r.annotations.some((a) => a.startsWith('::warning title=P3 alerts%3Aprovider%3Agfz::')));
    } else {
      assert.equal(e.open, true, iso);
      assert.equal(e.rule, 'alerts:provider:fast');
      assert.equal(e.enteredBy, 'ratio', `${iso}: the line at 13:52 does not re-enter`);
      assert.equal(r.comments.length, 0, iso);
    }
  }
  for (const iso of every15('2026-10-21T15:37:00Z', '2026-10-21T16:22:00Z')) {
    const r = w.run(iso, {});
    assert.equal(r.exitCode, 0);
    assert.equal(r.comments.length, 0, `${iso}: leaving is silent`);
    assert.equal(w.entry('alerts:provider:gfz')?.open ?? false, iso !== '2026-10-21T16:22:00.000Z', `${iso}: 4 healthy runs after a ratio entry`);
  }
  assert.equal(w.comments.length, 1, 'exactly one comment for the whole incident');
  const log = w.state('alerts')!.log;
  assert.deepEqual(log.map((x) => `${utcText(x.ms)} ${x.event}`), ['2026-10-21 13:37Z open', '2026-10-21 13:37Z notify', '2026-10-21 16:22Z resolve']);
  assert.deepEqual(w.state('alerts')!.days['2026-10-21'], { red: 0, comments: 1, transitions: 0, would: 0 });

  // The scheduled run of 15:22:39 that duplicated the dispatched one (created 15:22:30) is skipped by the gate.
  const dispatchedRuns = [
    { created_at: '2026-10-21T15:22:30Z', status: 'in_progress', conclusion: null },
    { created_at: '2026-10-21T15:07:31Z', status: 'completed', conclusion: 'success' },
  ];
  const gate = scheduleGate({ eventName: 'schedule', schedule: HEALTH_FALLBACK_CRON, selftestInput: '', dispatchedRuns, nowMs: T('2026-10-21T15:22:39Z') });
  assert.equal(gate.run, false);
  assert.match(gate.reason, /created 9 s ago/);

  // A document older than the one applied changes nothing.
  const before = structuredClone(w.bodies);
  const stale = w.docs(T('2026-10-21T16:30:00Z'), { alerts: [gfz('P3', since)] }, { generatedAtMs: T('2026-10-21T16:00:00Z') });
  const r = w.apply(T('2026-10-21T16:30:00Z'), stale);
  assert.equal(r.replay, true);
  assert.deepEqual(w.bodies, before);
  assert.deepEqual(r.comments, []);
});

test('2026-10-16: two short GFZ streaks stay P4 samples (no entry, no comment) and are pruned after 8 clean runs', () => {
  const w = new World();
  w.run('2026-10-16T08:07:00Z', { alerts: [gfz('P4', T('2026-10-16T08:02:00Z'))] });
  w.run('2026-10-16T08:22:00Z', {});
  w.run('2026-10-16T08:37:00Z', { alerts: [gfz('P4', T('2026-10-16T08:25:00Z'))] });
  assert.equal(w.entry('alerts:provider:gfz')!.open, false);
  assert.equal(w.entry('alerts:provider:gfz')!.samples, '101');
  const clean = every15('2026-10-16T08:52:00Z', '2026-10-16T10:37:00Z');
  assert.equal(clean.length, 8);
  for (const [i, iso] of clean.entries()) {
    const r = w.run(iso, {});
    assert.equal(r.exitCode, 0);
    assert.equal(w.entry('alerts:provider:gfz') !== undefined, i < 7, `${iso}: a '1' is still in the last 8 samples`);
  }
  assert.equal(w.comments.length, 0);
  assert.deepEqual(w.state('alerts')!.log, [], 'no episode, no event');
});

test('2026-10-04..06 USGS: enters past 30 min, escalates exactly 2 h after its start, silent for 31.6 h, resolves after 2 healthy runs', () => {
  const w = new World();
  const S = T('2026-10-04T18:07:00Z');
  const usgs = (nowMs: number): Finding => f('alerts:provider:usgs', { severity: nowMs - S >= 30 * MIN ? 'P3' : 'P4', sinceMs: S, text: 'usgs ok:false: FDSN and the summary feed both fail' });
  for (const iso of every15('2026-10-04T18:22:00Z', '2026-10-06T01:37:00Z')) {
    const nowMs = T(iso);
    const r = w.run(iso, { alerts: [usgs(nowMs)] });
    assert.equal(r.exitCode, 0, `${iso}: one external agency never turns a run red`);
    const e = w.entry('alerts:provider:usgs')!;
    assert.equal(e.open, nowMs >= S + 30 * MIN, iso);
    if (iso === '2026-10-04T18:37:00.000Z') {
      assert.equal(r.comments.length, 1);
      assert.match(r.comments[0]!.body, /\*\*P3 · `alerts:provider:usgs`\*\* USGS failing — usgs ok:false/);
    } else if (iso === '2026-10-04T20:07:00.000Z') {
      assert.equal(e.escalated, true);
      assert.equal(r.comments.length, 1);
      assert.match(r.comments[0]!.body, /\*\*P3 · `alerts:provider:usgs`\*\* USGS failing — open for 2\.0 h: /);
    } else assert.equal(r.comments.length, 0, iso);
    assert.deepEqual(signal(r, 'gh-aging'), [nowMs >= S + 2 * HOUR ? 'fail' : 'success'], iso);
    assert.deepEqual(failing(r).filter((c) => c !== 'gh-aging'), [], iso);
  }
  assert.equal(w.comments.length, 2, 'the entry and the escalation, nothing in the 31.6 h after');
  const a = w.run('2026-10-06T01:52:00Z', {});
  assert.equal(w.entry('alerts:provider:usgs')!.open, true, 'one healthy run is not enough');
  assert.equal(a.comments.length, 0);
  const b = w.run('2026-10-06T02:07:00Z', {});
  assert.equal(w.entry('alerts:provider:usgs'), undefined, 'resolved, and its samples cleared: nothing left to keep');
  assert.equal(w.state('alerts')!.log.at(-1)!.event, 'resolve');
  assert.equal(b.comments.length, 0, 'resolving is silent');
  assert.deepEqual(signal(b, 'gh-aging'), ['success']);
  assert.equal(w.state('alerts')!.days['2026-10-04']!.transitions, 1, 'gh-aging went to /fail once');
});

test('2026-10-04 USGS with EMSC also failing: coverage:two is red for its first hour, then green with ::error::; it mutes usgs until it resolves', () => {
  const w = new World();
  const S = T('2026-10-04T18:07:00Z');
  const usgs = (nowMs: number): Finding => f('alerts:provider:usgs', { severity: nowMs - S >= 30 * MIN ? 'P3' : 'P4', sinceMs: S, text: 'usgs ok:false' });
  const cov = f('alerts:coverage:two', { severity: 'P2', sinceMs: S + 5 * MIN, members: ['usgs', 'emsc'], text: 'usgs and emsc failing together for 181 s' });
  const expectRed: Record<string, number> = { '18:22': 1, '18:37': 1, '18:52': 1, '19:07': 1, '19:22': 0, '19:37': 0 };
  for (const [hm, red] of Object.entries(expectRed)) {
    const iso = `2026-10-04T${hm}:00Z`;
    const r = w.run(iso, { alerts: hm === '19:37' ? [usgs(T(iso))] : [usgs(T(iso)), cov] });
    assert.equal(r.exitCode, red, `${hm}: P2 red during its first hour only`);
    assert.equal(r.comments.length, 0, `${hm}: a P2 has no comment and usgs is muted`);
    assert.ok(r.annotations.some((x) => x.startsWith('::error title=P2 alerts%3Acoverage%3Atwo::')), `${hm}: still an ::error::`);
    assert.deepEqual(signal(r, 'gh-redundancy'), ['fail']);
    if (T(iso) >= S + 30 * MIN) assert.deepEqual(w.entry('alerts:provider:usgs')!.muted, { by: 'inhibited', note: 'inhibited by alerts:coverage:two' }, hm);
  }
  // 19:52: the second run without coverage:two resolves it; usgs is no longer muted and its entry comment goes out.
  const r = w.run('2026-10-04T19:52:00Z', { alerts: [usgs(T('2026-10-04T19:52:00Z'))] });
  assert.equal(w.entry('alerts:coverage:two')!, undefined);
  assert.equal(w.entry('alerts:provider:usgs')!.muted, null);
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0]!.body, /^\*\*P3 · `alerts:provider:usgs`\*\* USGS failing — usgs ok:false \(since 2026-10-04 18:07Z, 105 min\)/);
  assert.deepEqual(signal(r, 'gh-redundancy'), ['success']);
  assert.equal(w.state('alerts')!.days['2026-10-04']!.red, 4);
});

test('stale status.json: P1 and red, and every provider entry frozen (no counters, no resolve) even when a provider finding is present', () => {
  const w = new World();
  const cov = f('alerts:coverage:two', { severity: 'P2', members: ['emsc', 'gfz'], text: 'emsc and gfz failing together' });
  w.run('2026-10-21T10:07:00Z', { alerts: [gfz('P3', T('2026-10-21T08:50:00Z')), cov] });
  const gfzBefore = w.entry('alerts:provider:gfz')!;
  const covBefore = w.entry('alerts:coverage:two')!;
  assert.equal(gfzBefore.open && covBefore.open, true);
  const staleDoc = f('alerts:status:stale', { sinceMs: T('2026-10-21T10:15:00Z'), text: 'status.json is 420 s old' });
  for (const [iso, alerts] of [
    ['2026-10-21T10:22:00Z', [staleDoc]],
    ['2026-10-21T10:37:00Z', [staleDoc, gfz('P3', T('2026-10-21T08:50:00Z'))]],
  ] as const) {
    const r = w.run(iso, { alerts: [...alerts] }, { unjudged: { alerts: ['alerts:*'] } });
    assert.equal(r.exitCode, 1, iso);
    assert.deepEqual(signal(r, 'gh-detect'), ['fail']);
    for (const [key, old] of [['alerts:provider:gfz', gfzBefore], ['alerts:coverage:two', covBefore]] as const) {
      const now = w.entry(key)!;
      assert.equal(now.open, true, `${iso} ${key}`);
      for (const field of ['seenRuns', 'absentRuns', 'samples', 'lastSeenMs', 'severity', 'text'] as const) assert.deepEqual(now[field], old[field], `${iso} ${key}.${field}`);
      assert.match(now.frozen ?? '', /not judged this run/);
    }
  }
  // The document is fresh again: the stale entry resolves, and on that same run the providers are judged again: absent,
  // so coverage:two (2 runs to resolve) is only held open by its resolve count and is no longer red.
  const back = w.run('2026-10-21T10:52:00Z', {});
  assert.equal(w.entry('alerts:status:stale'), undefined);
  assert.equal(back.exitCode, 0, 'nothing is present this run: no evidence, no red');
  for (const key of ['alerts:provider:gfz', 'alerts:coverage:two']) {
    assert.equal(w.entry(key)!.absentRuns, 1, key);
    assert.equal(w.entry(key)!.frozen, null, key);
    assert.equal(w.entry(key)!.open, true, key);
  }
  w.run('2026-10-21T11:07:00Z', {});
  assert.equal(w.entry('alerts:provider:gfz'), undefined, 'resolved after its 2 healthy runs');
  assert.equal(w.entry('alerts:coverage:two'), undefined);
});

test('a fresh status.json right after a stale one is judged on that run: a P1 it shows is red at once (not one run late)', () => {
  const w = new World();
  const stale = f('alerts:status:stale', { sinceMs: T('2026-10-21T10:00:00Z'), text: 'status.json is 420 s old' });
  assert.equal(w.run('2026-10-21T10:07:00Z', { alerts: [stale] }, { unjudged: { alerts: ['alerts:*'] } }).exitCode, 1);
  const all = f('alerts:coverage:all', { sinceMs: T('2026-10-21T10:15:00Z'), members: ['usgs', 'emsc', 'gfz'], text: 'usgs, emsc and gfz all failing together for 7 min' });
  const r = w.run('2026-10-21T10:22:00Z', { alerts: [all] });
  assert.equal(w.entry('alerts:status:stale'), undefined);
  assert.equal(w.entry('alerts:coverage:all')!.open, true);
  assert.equal(w.entry('alerts:coverage:all')!.frozen, null);
  assert.equal(r.exitCode, 1);
  assert.match(r.summary, /\*\*Run verdict: red\*\*: P1 `alerts:coverage:all`/);
  assert.deepEqual(signal(r, 'gh-detect'), ['fail']);
  // A run that cannot read status.json freezes it (it cannot tell, so it stays red, even before the unreadable finding
  // confirms); the next fresh document without it resolves it.
  const back = w.run('2026-10-21T10:37:00Z', { alerts: [f('alerts:status:unreadable', { text: 'HTTP 522 after 3 attempt(s)' })] }, { unjudged: { alerts: ['alerts:*'] } });
  assert.match(w.entry('alerts:coverage:all')!.frozen ?? '', /not judged this run/);
  assert.equal(back.exitCode, 1);
  w.run('2026-10-21T10:52:00Z', { alerts: [] });
  assert.equal(w.entry('alerts:coverage:all'), undefined);
});

test('status.json unreadable: P4 (green) on the first run, P2 (red) on the second, resolved on the third', () => {
  const w = new World();
  const unreadable = f('alerts:status:unreadable', { text: 'cannot read status.json: HTTP 522 after 3 attempt(s)' });
  const r1 = w.run('2026-10-21T10:07:00Z', { alerts: [unreadable] }, { unjudged: { alerts: ['alerts:*'] } });
  assert.equal(r1.exitCode, 0);
  assert.equal(w.entry('alerts:status:unreadable')!.pending, 'confirming 1/2');
  const r2 = w.run('2026-10-21T10:22:00Z', { alerts: [unreadable] }, { unjudged: { alerts: ['alerts:*'] } });
  assert.equal(r2.exitCode, 1);
  assert.deepEqual(signal(r2, 'gh-platform'), ['fail']);
  assert.equal(r2.comments.length, 0);
  const r3 = w.run('2026-10-21T10:37:00Z', {});
  assert.equal(r3.exitCode, 0);
  assert.equal(w.entry('alerts:status:unreadable'), undefined);
  assert.deepEqual(failing(r3), []);
});

test('overlapping runs and reruns: the same or older documents leave state, bodies and comments unchanged, and a P1 stays red', () => {
  const w = new World();
  const degraded = f('alerts:degraded', { text: 'the degradation ladder is active (level 2)' });
  const first = w.run('2026-10-21T10:07:00Z', { alerts: [degraded], feed: [tmd()] });
  assert.equal(first.exitCode, 1);
  assert.equal(first.comments.length, 1, 'the tmd entry');
  const bodies = structuredClone(w.bodies);
  const states = w.prev();
  for (const [label, nowMs, docs] of [
    ['the same documents', T('2026-10-21T10:12:00Z'), w.lastDocs],
    ['older documents', T('2026-10-21T10:14:00Z'), w.docs(T('2026-10-21T09:52:00Z'), { alerts: [], feed: [] })],
  ] as const) {
    const r = w.apply(nowMs, [...docs]);
    assert.equal(r.replay, true, label);
    assert.deepEqual(r.state, states, label);
    assert.deepEqual(w.bodies, bodies, label);
    assert.deepEqual(r.comments, [], label);
    assert.deepEqual(r.create, [], label);
    assert.equal(r.exitCode, 1, `${label}: the P1 stays red`);
    assert.match(r.summary, /already applied/);
  }
  // One stale evaluator next to fresh ones: its keys are frozen, the others are judged.
  const mixed = w.apply(T('2026-10-21T10:22:00Z'), [...w.docs(T('2026-10-21T10:22:00Z'), { alerts: null, feed: [], platform: [] }), w.lastDocs[0]!]);
  assert.equal(mixed.replay, false);
  assert.equal(w.entry('alerts:degraded')!.open, true);
  assert.match(w.entry('alerts:degraded')!.frozen ?? '', /alerts findings are stale/);
  assert.equal(w.entry('feed:source:tmd'), undefined, 'judged absent: resolved');
});

test('confirmation and the red hour: unreachable is P4 then P2; stale is P2 at once, red at +0..+45 and green with ::error:: at +60', () => {
  const w = new World();
  const unreachable = f('feed:freshness:unreachable', { members: ['v2'], text: 'v2/manifest.json unreachable after 4 tries' });
  const r1 = w.run('2026-10-19T02:52:00Z', { feed: [unreachable] });
  assert.equal(r1.exitCode, 0);
  assert.equal(w.entry('feed:freshness')!.open, false);
  const r2 = w.run('2026-10-19T03:07:00Z', { feed: [unreachable] });
  assert.equal(r2.exitCode, 1);
  assert.equal(w.entry('feed:freshness')!.severity, 'P2');

  const v = new World();
  const stale = f('feed:freshness', { sinceMs: T('2026-10-20T09:40:00Z'), text: 'the v2 manifest is 41 min old (contract 30 min)' });
  for (const [i, iso] of every15('2026-10-20T10:07:00Z', '2026-10-20T11:22:00Z').entries()) {
    const r = v.run(iso, { feed: [stale] });
    assert.equal(r.exitCode, i < 4 ? 1 : 0, `+${i * 15} min`);
    assert.ok(r.annotations.some((a) => a.startsWith('::error title=P2 feed%3Afreshness::')), `+${i * 15} min`);
    assert.deepEqual(signal(r, 'gh-feed'), ['fail']);
    assert.equal(v.entry('feed:freshness')!.open, true);
    assert.equal(r.comments.length, 0);
  }
  assert.equal(P2_RED_MS, HOUR);
});

test('config v65/v66 replay: the gap holds 24 h, then a P3 entry; the age keeps it open; the rises to P2 (red 1 h) and P1 (red every run) are silent', () => {
  const w = new World();
  const gap = f('config:bundle:gap', { severity: 'P3', members: ['gap'], text: 'the data copy serves v65 while config.theshelter.app serves v66' });
  const age = (severity: Severity): Finding => f('config:bundle:age', { severity, sinceMs: T('2026-10-22T20:39:00Z'), members: ['age', 'gap'], text: `config bundle copy v65 is old (${severity})` });
  const steps: Array<[string, Finding, { exit: number; comment: RegExp | null; open: boolean }]> = [
    ['2026-10-19T11:07:00Z', gap, { exit: 0, comment: null, open: false }],
    ['2026-10-19T23:07:00Z', gap, { exit: 0, comment: null, open: false }],
    ['2026-10-20T11:07:00Z', gap, { exit: 0, comment: /^\*\*P3 · `config:bundle`\*\* config partial publish — the data copy serves v65/, open: true }],
    ['2026-10-21T11:07:00Z', gap, { exit: 0, comment: null, open: true }],
    ['2026-10-22T20:40:00Z', age('P3'), { exit: 0, comment: null, open: true }],
    ['2026-10-27T20:40:00Z', age('P2'), { exit: 1, comment: null, open: true }],
    ['2026-10-27T20:55:00Z', age('P2'), { exit: 1, comment: null, open: true }],
    ['2026-10-27T21:10:00Z', age('P2'), { exit: 1, comment: null, open: true }],
    ['2026-10-27T21:25:00Z', age('P2'), { exit: 1, comment: null, open: true }],
    ['2026-10-27T21:40:00Z', age('P2'), { exit: 0, comment: null, open: true }],
    ['2026-11-11T20:40:00Z', age('P1'), { exit: 1, comment: null, open: true }],
    ['2026-11-11T20:55:00Z', age('P1'), { exit: 1, comment: null, open: true }],
  ];
  for (const [iso, finding, want] of steps) {
    const r = w.run(iso, { platform: [finding] });
    const e = w.entry('config:bundle')!;
    assert.equal(r.exitCode, want.exit, iso);
    assert.equal(e.open, want.open, iso);
    if (want.comment) {
      assert.equal(r.comments.length, 1, iso);
      assert.match(r.comments[0]!.body, want.comment, iso);
    } else assert.equal(r.comments.length, 0, iso);
    if (iso === '2026-10-19T23:07:00Z') assert.equal(e.pending, 'holding 12.0 h of 24.0 h');
    if (iso === '2026-10-22T20:40:00Z') assert.deepEqual(e.members, ['age', 'gap']);
    if (iso.startsWith('2026-10-27')) assert.deepEqual(signal(r, 'gh-platform'), ['fail'], iso);
    if (iso.startsWith('2026-11-11')) {
      assert.deepEqual(signal(r, 'gh-deliver'), ['fail'], iso);
      assert.deepEqual(signal(r, 'gh-platform'), ['success'], iso);
    }
  }
  assert.deepEqual(w.state('platform')!.entries['config:bundle']!.rule, 'config:bundle:age');
  // A rise lands at P1 or P2: the red run (and its push) is the alarm, never a comment on the public board.
  assert.equal(w.entry('config:bundle')!.notified, 'P1');
  assert.equal(w.comments.length, 1, 'the P3 entry comment only');
});

test('inhibition: an open feed:freshness mutes a new feed source until it resolves; the gateway gfz entry mutes feed:source:geofon', () => {
  const w = new World();
  const stale = f('feed:freshness', { text: 'the v1 manifest is 35 min old' });
  const r1 = w.run('2026-10-21T10:07:00Z', { feed: [stale, tmd()] });
  assert.equal(w.entry('feed:source:tmd')!.open, true);
  assert.deepEqual(w.entry('feed:source:tmd')!.muted, { by: 'inhibited', note: 'inhibited by feed:freshness' });
  assert.equal(r1.comments.length, 0);
  assert.equal(r1.exitCode, 1, 'the freshness P2');
  const r2 = w.run('2026-10-21T10:22:00Z', { feed: [tmd()] });
  assert.equal(w.entry('feed:freshness'), undefined);
  assert.equal(r2.comments.length, 1);
  assert.match(r2.comments[0]!.body, /`feed:source:tmd`/);

  const g = new World();
  const geofon = f('feed:source:core', { id: 'geofon', severity: 'P3', sinceMs: T('2026-10-21T11:00:00Z'), members: ['fetch'], text: 'geofon fetch failing for 3.1 h' });
  const r = g.run('2026-10-21T14:07:00Z', { alerts: [gfz('P3', T('2026-10-21T12:50:00Z'))], feed: [geofon] });
  assert.deepEqual(g.entry('feed:source:geofon')!.muted, { by: 'inhibited', note: 'inhibited by alerts:provider:gfz' });
  assert.deepEqual(r.comments.map((c) => c.board), ['alerts']);
  // A gfz finding below its line (P4, entry not open) inhibits nothing.
  const h = new World();
  const r3 = h.run('2026-10-21T14:07:00Z', { alerts: [gfz('P4', T('2026-10-21T13:50:00Z'))], feed: [geofon] });
  assert.equal(h.entry('feed:source:geofon')!.muted, null);
  assert.deepEqual(r3.comments.map((c) => c.board), ['feed']);
});

test('silences: parseSilences, a silenced key gets no comment, a rise lifts it, an expired one posts the pending comment, red is untouched', () => {
  const now = T('2026-10-21T12:00:00Z');
  const parsed = parseSilences(' feed:source:tmd=2026-10-30,known TMD chain; alerts:provider:*=2026-10-21T18:00Z,maintenance, planned;bad;x:y=2026-02-30,z;*=2026-10-30,all;feed:size=2026-10-01,old;', now);
  assert.deepEqual(parsed.silences, [
    { pattern: 'feed:source:tmd', untilMs: T('2026-10-31T00:00:00Z'), reason: 'known TMD chain', spec: 'feed:source:tmd=2026-10-30,known TMD chain' },
    { pattern: 'alerts:provider:*', untilMs: T('2026-10-21T18:00:00Z'), reason: 'maintenance, planned', spec: 'alerts:provider:*=2026-10-21T18:00Z,maintenance, planned' },
  ]);
  assert.equal(parsed.errors.length, 4);
  assert.match(parsed.errors[0]!, /"bad": not key=until,reason/);
  assert.match(parsed.errors[1]!, /until must be YYYY-MM-DD/);
  assert.match(parsed.errors[2]!, /not \* alone/);
  assert.match(parsed.errors[3]!, /expired at 2026-10-02 00:00Z/);
  const many = parseSilences(Array.from({ length: MAX_SILENCES + 2 }, (_, i) => `walks:history:s${i}=2026-12-01`).join(';'), now);
  assert.equal(many.silences.length, MAX_SILENCES);
  assert.equal(many.errors.length, 2);
  assert.deepEqual(parseSilences(undefined, now), { silences: [], errors: [] });

  // A silenced key: no comment, muted, and the comment is due once the silence expires.
  const w = new World();
  const short = parseSilences('feed:source:tmd=2026-10-21T12:30Z,chain known', now).silences;
  const r1 = w.run('2026-10-21T12:07:00Z', { feed: [tmd()] }, { silences: short });
  assert.equal(r1.comments.length, 0);
  assert.equal(w.entry('feed:source:tmd')!.muted?.by, 'silenced');
  assert.match(w.entry('feed:source:tmd')!.muted!.note, /silenced until 2026-10-21 12:30Z: chain known/);
  assert.equal(w.run('2026-10-21T12:22:00Z', { feed: [tmd()] }, { silences: short }).comments.length, 0);
  const r3 = w.run('2026-10-21T12:37:00Z', { feed: [tmd()] }, { silences: short });
  assert.equal(r3.comments.length, 1, 'the expired silence posts the pending entry comment');
  assert.equal(w.entry('feed:source:tmd')!.muted, null);

  // A rise above the silenced severity lifts the silence (the P2 pings again); a silence never stops red.
  const v = new World();
  const all = parseSilences('config:bundle=2026-11-30,owner knows;feed:freshness=2026-11-30,owner knows', now).silences;
  const age = (severity: Severity): Finding => f('config:bundle:age', { severity, text: `the config copy is old (${severity})` });
  const a = v.run('2026-10-22T20:40:00Z', { platform: [age('P3')] }, { silences: all });
  assert.equal(a.comments.length, 0);
  assert.deepEqual(v.entry('config:bundle')!.silence, { spec: 'config:bundle=2026-11-30,owner knows', severity: 'P3' });
  const b = v.run('2026-10-27T20:40:00Z', { platform: [age('P2')], feed: [f('feed:freshness', { text: 'v1 manifest 40 min old' })] }, { silences: all });
  assert.equal(v.entry('config:bundle')!.muted, null, 'lifted by the rise');
  assert.deepEqual(signal(b, 'gh-platform'), ['fail']);
  // It was never announced while silenced, so the P2 is announced like a new one: by the red run, not a comment.
  assert.equal(b.comments.length, 0);
  assert.equal(v.entry('config:bundle')!.notified, 'P2');
  assert.equal(v.entry('feed:freshness')!.muted?.by, 'silenced');
  assert.deepEqual(signal(b, 'gh-feed'), ['success'], 'a silenced entry does not ping');
  assert.equal(b.exitCode, 1, 'silences never stop red');
  const c = v.run('2026-11-11T20:40:00Z', { platform: [age('P1')] }, { silences: all });
  assert.equal(c.comments.length, 0, 'a later rise is silent too: the red run announces it');
  assert.equal(c.exitCode, 1);
  assert.equal(v.entry('config:bundle')!.notified, 'P1');
});

test('shadow rules: the canary, provider-silent, latency and feed:systemic log would-notify once, never a comment, a red run or a ping', () => {
  const w = new World();
  const shadow = (): Findings => ({
    alerts: [
      f('alerts:canary', { sinceMs: T('2026-10-21T09:45:00Z'), text: 'USGS us7000abcd M4.6 is 20 min old; lastEvent 3.0 h old' }),
      f('alerts:provider-silent', { id: 'gfz', severity: 'P3', text: 'gfz watermark 13.0 h old' }),
    ],
    feed: [f('feed:systemic', { severity: 'P2', members: ['usgs', 'emsc'], text: 'usgs and emsc failing for 31 min' })],
  });
  for (const iso of ['2026-10-21T10:07:00Z', '2026-10-21T10:22:00Z']) {
    const r = w.run(iso, shadow());
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.comments, []);
    assert.deepEqual(failing(r), []);
    assert.deepEqual(r.labels.feed, ['health-board', 'health:ok']);
    assert.ok(r.annotations.some((a) => a.startsWith('::notice title=P4 alerts%3Acanary::')));
    assert.ok(r.annotations.some((a) => a.startsWith('::notice title=P2 feed%3Asystemic::')));
  }
  const would = BOARD_IDS.flatMap((b) => w.state(b)?.log ?? []).filter((x) => x.event === 'would-notify').map((x) => x.key).sort();
  assert.deepEqual(would, ['alerts:canary', 'alerts:provider-silent:gfz', 'feed:systemic']);
  assert.equal(w.state('alerts')!.days['2026-10-21']!.would, 2);
  assert.match(w.bodies.feed!, /### Shadow rules \(log only\)\n\n\| Sev \| Key \| Since \| Condition \|\n\|---\|---\|---\|---\|\n\| P2 \| `feed:systemic` \|/);
  w.run('2026-10-21T10:37:00Z', {});
  assert.deepEqual(w.state('feed')!.log.map((x) => x.event), ['open', 'would-notify'], 'feed:systemic resolves only after 30 min below its lines');
  w.run('2026-10-21T10:52:00Z', {});
  assert.deepEqual(w.state('feed')!.log.map((x) => x.event), ['open', 'would-notify', 'would-resolve']);
  assert.deepEqual(w.state('alerts')!.log.map((x) => `${x.key} ${x.event}`), [
    'alerts:canary open',
    'alerts:provider-silent:gfz open',
    'alerts:provider-silent:gfz would-notify',
    'alerts:canary would-notify',
    'alerts:canary would-resolve',
    'alerts:provider-silent:gfz would-resolve',
  ]);

  // latency: a P4 sample per run over the line; would-notify on the 4th of 8.
  const v = new World();
  const slow = f('alerts:latency', { id: 'emsc', severity: 'P4', text: 'emsc latency 3400 ms' });
  for (const [i, iso] of every15('2026-10-21T10:07:00Z', '2026-10-21T10:52:00Z').entries()) {
    const r = v.run(iso, { alerts: [slow] });
    assert.equal(v.entry('alerts:latency:emsc')!.open, i === 3, iso);
    assert.equal(r.exitCode, 0);
  }
  assert.deepEqual(v.state('alerts')!.log.map((x) => x.event), ['open', 'would-notify']);
});

test('never red: one external agency at P1 and the watcher stay green', () => {
  const w = new World();
  const r = w.run('2026-10-21T10:07:00Z', { alerts: [f('alerts:provider:usgs', { severity: 'P1', sinceMs: T('2026-10-21T09:30:00Z'), text: 'hand-built P1' })] });
  assert.equal(w.entry('alerts:provider:usgs')!.open, true);
  assert.equal(r.exitCode, 0);
  const watcher = f('watcher', { id: 'cf-usage', severity: 'P1', text: 'the analytics token was refused' });
  w.run('2026-10-21T10:22:00Z', { alerts: [watcher] });
  const r2 = w.run('2026-10-21T10:37:00Z', { alerts: [watcher] });
  assert.equal(w.entry('watcher:cf-usage')!.open, true);
  assert.equal(r2.exitCode, 0);
  assert.deepEqual(r2.labels.platform, ['health-board', 'health:p1'], 'the label still shows it');
});

test('a missing evaluator: watcher:evaluator:<e> confirms over 2 runs, its entries freeze, health-watchdog fails on dispatched runs only', () => {
  const w = new World();
  w.run('2026-10-21T10:07:00Z', { feed: [tmd()] });
  assert.equal(w.entry('feed:source:tmd')!.open, true);
  const r1 = w.run('2026-10-21T10:22:00Z', { feed: null }, { missing: { feed: 'feed.json is unreadable: Unexpected end of JSON input' } });
  const watcher = w.entry('watcher:evaluator:feed')!;
  assert.equal(watcher.open, false);
  assert.equal(watcher.pending, 'confirming 1/2');
  assert.equal(watcher.evaluator, null);
  assert.match(watcher.text, /the feed evaluator produced no findings this run \(feed\.json is unreadable: Unexpected end of JSON input\)/);
  const t1 = w.entry('feed:source:tmd')!;
  assert.equal(t1.absentRuns, 0, 'frozen: not counted as absent');
  assert.match(t1.frozen ?? '', /the feed findings are missing/);
  assert.deepEqual(signal(r1, 'health-watchdog'), ['fail']);
  assert.match(r1.pings.find((p) => p.check === 'health-watchdog')!.reason, /no findings from feed/);
  assert.equal(r1.exitCode, 0);
  const r2 = w.run('2026-10-21T10:37:00Z', { feed: null }, { eventName: 'schedule' });
  assert.equal(w.entry('watcher:evaluator:feed')!.open, true);
  assert.deepEqual(r2.comments.map((c) => c.board), ['platform']);
  assert.match(r2.comments[0]!.body, /\*\*P3 · `watcher:evaluator:feed`\*\* watcher fault — /);
  assert.deepEqual(signal(r2, 'health-watchdog'), [], 'not pinged on schedule');
  assert.equal(r2.exitCode, 0, 'the watcher is never red');
  const r3 = w.run('2026-10-21T10:52:00Z', { feed: [] });
  assert.equal(w.entry('watcher:evaluator:feed'), undefined, 'resolved');
  assert.equal(w.entry('feed:source:tmd'), undefined, 'judged again: absent, resolved');
  assert.deepEqual(signal(r3, 'health-watchdog'), ['success']);
  // An invalid document counts as missing too.
  const v = new World();
  const bad = { ...findingsDocument({ evaluator: 'feed', generatedAtMs: T('2026-10-21T10:06:30Z'), findings: [] }), findings: [{ key: 'feed:size' }] };
  const rv = v.apply(T('2026-10-21T10:07:00Z'), [...v.docs(T('2026-10-21T10:07:00Z'), { feed: null }), bad]);
  assert.match(v.entry('watcher:evaluator:feed')!.text, /invalid findings document: finding 0 \(feed:size\)/);
  assert.equal(rv.evaluators.feed.state, 'missing');
});

test('pings: the verdict checks, gh-aging, and the selftest (fail then success, red, no board row)', () => {
  const w = new World();
  const r = w.run('2026-10-21T10:07:00Z', {
    alerts: [f('alerts:degraded', { text: 'ladder active' }), f('alerts:budget', { severity: 'P2', members: ['doRowsWritten'], text: 'rows written projected at 80 %' })],
  });
  assert.deepEqual(failing(r).sort(), ['gh-capacity', 'gh-deliver']);
  assert.deepEqual(r.pings.map((p) => p.check), ['gh-detect', 'gh-deliver', 'gh-redundancy', 'gh-feed', 'gh-platform', 'gh-capacity', 'gh-aging', 'health-watchdog']);
  assert.match(r.pings.find((p) => p.check === 'gh-deliver')!.reason, /^P1 alerts:degraded: ladder active$/);
  assert.equal(w.state('alerts')!.days['2026-10-21']!.transitions, 2);
  assert.deepEqual(w.state('alerts')!.checks['gh-deliver'], 'fail');
  w.run('2026-10-21T10:22:00Z', { alerts: [f('alerts:degraded', { text: 'ladder active' }), f('alerts:budget', { severity: 'P2', members: ['doRowsWritten'], text: 'rows written projected at 80 %' })] });
  assert.equal(w.state('alerts')!.days['2026-10-21']!.transitions, 2, 'a check already failing is no new transition');

  const s = new World();
  const st = s.run('2026-11-01T09:17:00Z', { alerts: [f('alerts:selftest', { text: 'forced by the selftest: this run must be red' })] });
  assert.equal(st.exitCode, 1);
  assert.deepEqual(st.pings.filter((p) => p.check === 'selftest').map((p) => p.signal), ['fail', 'success']);
  for (const b of BOARD_IDS) assert.deepEqual(st.state[b]!.entries, {}, `${b}: no board row`);
  assert.equal(s.state('alerts')!.lastSelftestMs, T('2026-11-01T09:17:00Z'), 'recorded, on every board');
  assert.equal(s.state('platform')!.lastSelftestMs, T('2026-11-01T09:17:00Z'));
  assert.match(s.bodies.alerts!, /Last selftest \(the forced P1 that proves the red run\): 2026-11-01 09:17Z\./);
  assert.ok(st.annotations.includes('::error title=P1 alerts%3Aselftest::forced by the selftest: this run must be red'));
  assert.match(st.summary, /\*\*Run verdict: red\*\*: the selftest/);
});

test('body: round trip, escaping of untrusted text, a broken marker, and 42 open sources plus 300 log events under the limit', () => {
  const w = new World();
  const nasty = 'x --> y | z @user #12 <img src=x> `tick`';
  const r = w.run('2026-10-21T10:07:00Z', { feed: [f('feed:source:definite', { id: 'tmd', sinceMs: T('2026-10-21T07:50:00Z'), members: ['fetch'], text: nasty })] });
  const body = w.bodies.feed!;
  assert.equal(body.indexOf('-->'), body.lastIndexOf('-->'), 'only the marker ends a comment');
  assert.ok(body.trimEnd().endsWith(' -->'));
  assert.match(body, /x --&gt; y \\\| z @​user #​12 &lt;img src=x&gt; tick/);
  assert.match(r.comments[0]!.body, /x --&gt; y \\\| z @​user #​12 &lt;img src=x&gt; tick/);
  assert.equal(w.entry('feed:source:tmd')!.text, 'x --> y | z @user #12 <img src=x> tick', 'the state keeps the text (only backticks stripped)');
  assert.equal(markdownText('a|b@c#1<d>'), 'a\\|b@​c#​1&lt;d&gt;');
  assert.equal(markdownText('#x stays'), '#x stays');

  const state = w.state('feed')!;
  assert.deepEqual(parseBoardState(renderBody('feed', state), 'feed'), state);
  assert.equal(parseBoardState(body, 'alerts'), null, 'a wrong board');
  assert.equal(parseBoardState(body.replace('"v":1', '"v":2'), 'feed'), null, 'a wrong version');
  assert.equal(parseBoardState(body.replace(/ -->\n$/, '\n'), 'feed'), null, 'an unterminated marker');
  assert.equal(parseBoardState(body.replace('{"v":1', '{"v":1,,'), 'feed'), null, 'broken JSON');
  assert.equal(parseBoardState('no marker here', 'feed'), null);
  assert.equal(parseBoardState(null), null);
  // A hand edit that breaks one entry drops only that entry.
  const edited = parseBoardState(body.replace('"rule":"feed:source:definite"', '"rule":"no-such-rule"'), 'feed')!;
  assert.deepEqual(Object.keys(edited.entries), []);

  // 42 open sources with long texts, plus a full state log: the body still fits and every row stays.
  const ids = Array.from({ length: 42 }, (_, i) => `source${String(i).padStart(2, '0')}`);
  const big = ids.map((id) => f('feed:source', { id, members: ['fetch', 'silent'], sinceMs: T('2026-10-20T10:00:00Z'), text: `${id} fetch failing: ${'a long upstream error message '.repeat(12)}` }));
  const v = new World();
  v.run('2026-10-21T10:07:00Z', { feed: big });
  const prev = v.prev();
  prev.feed!.log = Array.from({ length: LOG_MAX_EVENTS }, (_, i) => ({ ms: T('2026-10-21T10:07:00Z') - (LOG_MAX_EVENTS - i) * MIN, key: ids[i % 42]!, event: 'notify' as const, severity: 'P3' as const }));
  v.bodies.feed = renderBody('feed', prev.feed!);
  const out = v.run('2026-10-21T10:22:00Z', { feed: big });
  assert.ok(renderBody('feed', prev.feed!).length > MAX_BODY_CHARS, 'unshrunk, it would not fit');
  assert.ok(out.bodies.feed!.length <= MAX_BODY_CHARS, `${out.bodies.feed!.length}`);
  assert.equal(Object.values(out.state.feed!.entries).filter((e) => e.open).length, 42);
  assert.ok(out.state.feed!.log.length < LOG_MAX_EVENTS, 'the oldest state log events went first');
  assert.match(out.bodies.feed!, /\d+ event\(s\) are kept in the state only\.|older event\(s\) are kept in the state only\./);
});

test('labels follow the worst open severity; the 7-day counts and the log drop what is older than 7 days', () => {
  const w = new World();
  assert.deepEqual(w.run('2026-10-21T10:07:00Z', { feed: [tmd()] }).labels.feed, ['health-board', 'health:p3']);
  assert.deepEqual(w.run('2026-10-21T10:22:00Z', { feed: [tmd(), f('feed:freshness', { text: 'stale' })] }).labels.feed, ['health-board', 'health:p2']);
  const r = w.run('2026-10-21T10:37:00Z', { alerts: [f('alerts:policy', { text: 'fallback policy' })] });
  assert.deepEqual(r.labels, { alerts: ['health-board', 'health:p1'], feed: ['health-board', 'health:ok'], platform: ['health-board', 'health:ok'] });

  const prev = w.prev();
  prev.feed!.days = { '2026-10-10': { red: 9, comments: 9, transitions: 9, would: 9 }, '2026-10-15': { red: 1, comments: 2, transitions: 3, would: 4 }, ...prev.feed!.days };
  prev.feed!.log = [{ ms: T('2026-10-14T10:00:00Z'), key: 'feed:source:old', event: 'open', severity: 'P3' }, ...prev.feed!.log];
  w.bodies.feed = renderBody('feed', prev.feed!);
  w.run('2026-10-21T10:52:00Z', {});
  const days = w.state('feed')!.days;
  assert.deepEqual(Object.keys(days), ['2026-10-15', '2026-10-21']);
  assert.ok(w.state('feed')!.log.every((x) => x.ms >= T('2026-10-14T10:52:00Z')));
  // Today: the freshness P2 was red once, tmd got its comment, gh-feed went to /fail once; plus 10-15.
  assert.match(w.bodies.feed!, /\| 2026-10-21 \| 1 \| 1 \| 1 \| 0 \|\n\| 2026-10-15 \| 1 \| 2 \| 3 \| 4 \|\n\| \*\*7 days\*\* \| 2 \| 3 \| 4 \| 4 \|/);
  assert.ok(!w.bodies.feed!.includes('2026-10-10'));
  assert.ok(!w.bodies.feed!.includes('feed:source:old'));
  assert.match(w.bodies.feed!, /pings skipped: HC_PING_KEY unset/);
});

test('scheduleGate: the fallback cron skips within 20 min of a dispatched run (whatever its status, unless cancelled or skipped); everything else runs', () => {
  const now = T('2026-10-21T15:25:00Z');
  const gate = (o: Partial<Parameters<typeof scheduleGate>[0]>): ReturnType<typeof scheduleGate> =>
    scheduleGate({ eventName: 'schedule', schedule: HEALTH_FALLBACK_CRON, selftestInput: '', dispatchedRuns: [], nowMs: now, ...o });
  const run = (agoMs: number, status = 'in_progress', conclusion: string | null = null): { created_at: string; status: string; conclusion: string | null } => ({ created_at: new Date(now - agoMs).toISOString(), status, conclusion });
  assert.equal(gate({ dispatchedRuns: [run(9 * SEC)] }).run, false);
  assert.equal(gate({ dispatchedRuns: [run(9 * SEC, 'queued')] }).run, false);
  assert.equal(gate({ dispatchedRuns: [run(9 * SEC, 'completed', 'failure')] }).run, false, 'a red run judged');
  assert.equal(gate({ dispatchedRuns: [run(21 * MIN)] }).run, true);
  assert.equal(gate({ dispatchedRuns: [run(SCHEDULE_SKIP_MS - SEC), { created_at: 'garbage' }] }).run, false);
  assert.equal(gate({ dispatchedRuns: null }).run, true);
  assert.equal(gate({ dispatchedRuns: [] }).run, true);
  assert.equal(gate({ eventName: 'workflow_dispatch', dispatchedRuns: [run(0)] }).run, true);
  // A dispatched run that judged nothing does not stand in for the fallback: a pending run that a newer arrival in the
  // `health` concurrency group cancelled (the fallback itself, or the next dispatch), or one that was skipped.
  const cancelled = gate({ dispatchedRuns: [run(3 * MIN, 'completed', 'cancelled'), run(9 * MIN, 'completed', 'skipped'), run(25 * MIN, 'completed', 'success')] });
  assert.equal(cancelled.run, true);
  assert.match(cancelled.reason, /no workflow_dispatch health run \(not cancelled or skipped\) created in the last 20 min/);
  assert.equal(gate({ dispatchedRuns: [run(3 * MIN, 'completed', 'cancelled'), run(12 * MIN, 'completed', 'success')] }).run, false, 'an earlier one that judged still counts');
  assert.deepEqual(gate({ eventName: 'schedule', schedule: SELFTEST_CRON }), { run: true, selftest: true, reason: `schedule '${SELFTEST_CRON}'` });
  assert.equal(gate({ eventName: 'workflow_dispatch', selftestInput: 'true' }).selftest, true);
  assert.equal(gate({ eventName: 'workflow_dispatch', selftestInput: true }).selftest, true);
  assert.equal(gate({ eventName: 'workflow_dispatch', selftestInput: 'false' }).selftest, false);
  assert.equal(SELFTEST_CRON, '17 9 1 * *');
});

test('small helpers: pingUrl, annotation, parseArgs', () => {
  assert.equal(pingUrl('k', 'gh-detect', 'fail'), `${HC_PING_BASE}/k/gh-detect/fail`);
  assert.equal(pingUrl('k', 'gh-detect', 'success'), `${HC_PING_BASE}/k/gh-detect/0`);
  assert.equal(annotation('warning', 'P3 a:b, c', 'line\n100%'), '::warning title=P3 a%3Ab%2C c::line%0A100%25');
  assert.equal(annotation('error', null, 'boards unreadable'), '::error::boards unreadable');
  assert.deepEqual(parseArgs(['--findings-dir', 'findings', '--dry-run']), { gate: false, findingsDir: 'findings', dryRun: true });
  assert.deepEqual(parseArgs(['--gate']), { gate: true, findingsDir: null, dryRun: false });
  assert.throws(() => parseArgs([]), /one of --gate or --findings-dir/);
  assert.throws(() => parseArgs(['--findings-dir']), /needs a value/);
  assert.throws(() => parseArgs(['--gate', '--findings-dir', 'x']), /exclude each other/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('duplicate findings of one key: the worst severity wins and the members merge', () => {
  const w = new World();
  w.run('2026-10-21T10:07:00Z', {
    alerts: [
      f('alerts:coverage:two', { severity: 'P4', members: ['usgs'], text: 'two failing, under 180 s' }),
      f('alerts:coverage:two', { severity: 'P2', members: ['emsc'], text: 'two failing, 200 s' }),
    ],
  });
  const e = w.entry('alerts:coverage:two')!;
  assert.equal(e.severity, 'P2');
  assert.equal(e.text, 'two failing, 200 s');
  assert.deepEqual(e.members, ['usgs', 'emsc']);
});

// ---------------------------------------------------------------------------------------------------------
// The review fixes of 2026-10-22 (logic review, incident replay, workflow review)

test('a resolved entry starts its samples afresh: one blip after a resolve re-opens nothing and posts nothing', () => {
  // The 2026-10-21 GEOFON replay (a ratio entry, resolved after 4 healthy runs) plus one P4 blip at 16:37.
  const w = new World();
  const since = T('2026-10-21T12:50:00Z');
  for (const iso of every15('2026-10-21T12:52:00Z', '2026-10-21T15:22:00Z')) w.run(iso, { alerts: [gfz(T(iso) - since >= 60 * MIN ? 'P3' : 'P4', since)] });
  for (const iso of every15('2026-10-21T15:37:00Z', '2026-10-21T16:22:00Z')) w.run(iso, {});
  assert.equal(w.entry('alerts:provider:gfz'), undefined, 'resolved: no sample is kept');
  const blip = w.run('2026-10-21T16:37:00Z', { alerts: [gfz('P4', T('2026-10-21T16:36:30Z'))] });
  assert.equal(w.entry('alerts:provider:gfz')!.open, false);
  assert.equal(w.entry('alerts:provider:gfz')!.samples, '1');
  assert.deepEqual(blip.comments, []);
  assert.equal(w.comments.length, 1, 'the one entry comment of the incident');

  // A line entry (USGS 30 min): 6 runs present, resolved after 2 healthy runs, then one blip (was 6 of the last 8).
  const v = new World();
  const S = T('2026-10-05T03:00:00Z');
  const usgs = (nowMs: number, sinceMs = S): Finding => f('alerts:provider:usgs', { severity: nowMs - sinceMs >= 30 * MIN ? 'P3' : 'P4', sinceMs, text: 'usgs ok:false' });
  for (const iso of every15('2026-10-05T03:07:00Z', '2026-10-05T04:22:00Z')) v.run(iso, { alerts: [usgs(T(iso))] });
  v.run('2026-10-05T04:37:00Z', {});
  v.run('2026-10-05T04:52:00Z', {});
  assert.equal(v.entry('alerts:provider:usgs'), undefined);
  const again = v.run('2026-10-05T05:07:00Z', { alerts: [usgs(T('2026-10-05T05:07:00Z'), T('2026-10-05T05:06:00Z'))] });
  assert.equal(v.entry('alerts:provider:usgs')!.open, false);
  assert.deepEqual(again.comments, []);
  assert.deepEqual(signal(again, 'gh-aging'), ['success']);
});

test('the episode start: a streak after a day of blips enters with its own start (no escalation in the same run); one past its line on entry gets one item', () => {
  // GFZ blips once every 90 min for a day (the logic review's t1 case 3), then a real 60-min streak.
  const w = new World();
  every15('2026-10-20T00:07:00Z', '2026-10-20T23:52:00Z').forEach((iso, i) => {
    w.run(iso, i % 6 === 0 ? { alerts: [gfz('P4', T(iso) - 30 * SEC)] } : {});
  });
  const s0 = T('2026-10-21T00:00:00Z');
  for (const iso of every15('2026-10-21T00:07:00Z', '2026-10-21T01:07:00Z')) {
    const r = w.run(iso, { alerts: [gfz(T(iso) - s0 >= 60 * MIN ? 'P3' : 'P4', s0)] });
    const e = w.entry('alerts:provider:gfz')!;
    if (r.comments.length === 0) continue;
    assert.equal(r.comments[0]!.body.split('\n\n').length, 2, `${iso}: one item and the run line`);
    assert.equal(e.escalated, false, iso);
    assert.ok(e.episodeSinceMs! >= T('2026-10-20T22:00:00Z'), `${iso}: dated by this streak and the window's samples, not ${utcText(e.episodeSinceMs)}`);
    assert.deepEqual(signal(r, 'gh-aging'), ['success']);
  }
  assert.equal(w.comments.length, 1);

  // The first run after the rollout finds USGS failing for 6 h: past its 2 h line on entry, so one item says both.
  const v = new World();
  const r = v.run('2026-10-21T10:07:00Z', { alerts: [f('alerts:provider:usgs', { sinceMs: T('2026-10-21T04:07:00Z'), text: 'usgs ok:false: FDSN and the summary feed both fail' })] });
  assert.equal(r.comments.length, 1);
  const items = r.comments[0]!.body.split('\n\n');
  assert.equal(items.length, 2, 'one item');
  assert.equal(items[0], '**P3 · `alerts:provider:usgs`** USGS failing — usgs ok:false: FDSN and the summary feed both fail (since 2026-10-21 04:07Z, 6.0 h); past its 2.0 h escalation line');
  assert.deepEqual(signal(r, 'gh-aging'), ['fail']);
  assert.deepEqual(r.comments[0]!.keys, [{ key: 'alerts:provider:usgs', notified: null, escalationNotified: false }]);
  assert.equal(v.run('2026-10-21T10:22:00Z', { alerts: [f('alerts:provider:usgs', { sinceMs: T('2026-10-21T04:07:00Z'), text: 'usgs ok:false' })] }).comments.length, 0);
});

test('a finding whose start is unknown (sinceMs null) is held for its rule\'s line from the first run that saw it, which dates its episode', () => {
  const w = new World();
  const never = (): Finding => f('feed:source:definite', { id: 'newsrc', sinceMs: null, members: ['fetch'], text: 'newsrc fetch failing, never fetched successfully (HTTP 404)' });
  const first = T('2026-10-22T10:07:00Z');
  for (const iso of every15('2026-10-22T10:07:00Z', '2026-10-22T11:52:00Z')) {
    const r = w.run(iso, { feed: [never()] });
    assert.equal(w.entry('feed:source:newsrc')!.open, false, iso);
    assert.deepEqual(r.comments, [], iso);
  }
  assert.equal(w.entry('feed:source:newsrc')!.pending, 'holding 105 min of 2.0 h (its start is unknown)');
  const r = w.run('2026-10-22T12:07:00Z', { feed: [never()] });
  const e = w.entry('feed:source:newsrc')!;
  assert.equal(e.open, true);
  assert.equal(e.episodeSinceMs, first);
  assert.match(r.comments[0]!.body, /\(since 2026-10-22 10:07Z, 2\.0 h\)$/m);
  // Escalation at 24 h counted from that first sighting.
  assert.equal(w.run('2026-10-23T09:52:00Z', { feed: [never()] }).comments.length, 0);
  const esc = w.run('2026-10-23T10:07:00Z', { feed: [never()] });
  assert.match(esc.comments[0]!.body, /— open for 24\.0 h: /);
});

test('red only on evidence: a P2 held open only by its resolve count is not red; a frozen one is', () => {
  const w = new World();
  const cov = f('alerts:coverage:two', { sinceMs: T('2026-10-21T10:00:00Z'), members: ['emsc', 'gfz'], text: 'emsc and gfz failing together for 7 min' });
  assert.equal(w.run('2026-10-21T10:07:00Z', { alerts: [cov] }).exitCode, 1);
  const after = w.run('2026-10-21T10:22:00Z', { alerts: [] });
  assert.equal(w.entry('alerts:coverage:two')!.open, true, 'one healthy run of 2');
  assert.equal(after.exitCode, 0, 'the outage is over: no red email about it');
  assert.ok(after.annotations.some((a) => a.startsWith('::error title=P2 alerts%3Acoverage%3Atwo::')), 'still an open row');
  assert.deepEqual(signal(after, 'gh-redundancy'), ['fail'], 'the ping holds until it resolves (no flapping push)');
  w.run('2026-10-21T10:37:00Z', { alerts: [] });
  assert.equal(w.entry('alerts:coverage:two'), undefined);
  assert.equal(w.state('alerts')!.days['2026-10-21']!.red, 1);
  // Back on the next run (still inside its first hour) it is red again; frozen (the alerts job failed) it stays red.
  const v = new World();
  v.run('2026-10-21T10:07:00Z', { alerts: [cov] });
  assert.equal(v.run('2026-10-21T10:22:00Z', { alerts: null }).exitCode, 1, 'frozen: cannot tell');
});

test('inhibition holds a comment back only while the child\'s own finding is present: one that cleared under its parent never comments', () => {
  // A feed outage with the gateway backstop failing too; on the recovery run both conditions are gone.
  const w = new World();
  const fresh = f('feed:freshness', { sinceMs: T('2026-10-21T10:00:00Z'), text: 'the v2 manifest is 45 min old' });
  const backstop = f('alerts:provider:feed', { sinceMs: T('2026-10-21T09:35:00Z'), text: 'the gateway feed backstop is failing' });
  for (const iso of every15('2026-10-21T10:07:00Z', '2026-10-21T11:07:00Z')) {
    w.run(iso, { feed: [fresh], alerts: [backstop] });
    assert.equal(w.entry('alerts:provider:feed')!.muted?.by, 'inhibited', iso);
  }
  const recovery = w.run('2026-10-21T11:22:00Z', {});
  assert.equal(w.entry('alerts:provider:feed')!.open, true, 'held open by its 2-run resolve');
  assert.equal(w.entry('alerts:provider:feed')!.muted, null);
  assert.deepEqual(recovery.comments, []);
  w.run('2026-10-21T11:37:00Z', {});
  assert.equal(w.entry('alerts:provider:feed'), undefined);
  assert.equal(w.comments.length, 0, 'never a comment for a muted child that cleared');

  // The backstop still failing once the parent resolved: its delayed comment goes out on that run.
  const v = new World();
  v.run('2026-10-21T10:07:00Z', { feed: [fresh], alerts: [backstop] });
  const r = v.run('2026-10-21T10:22:00Z', { alerts: [backstop] });
  assert.match(r.comments[0]!.body, /`alerts:provider:feed`/);

  // A silence that ends while its key is absent (held open by its resolve count) still posts, as before.
  const s = new World();
  const now = T('2026-10-21T10:00:00Z');
  const silences = parseSilences('alerts:provider:feed=2026-10-21T10:30Z,backstop maintenance', now).silences;
  s.run('2026-10-21T10:07:00Z', { alerts: [backstop] }, { silences });
  s.run('2026-10-21T10:22:00Z', { alerts: [backstop] }, { silences });
  const ended = s.run('2026-10-21T10:37:00Z', {}, { silences });
  assert.match(ended.comments[0]!.body, /`alerts:provider:feed`/);
});

test('escalation only on a run where the finding is present: a recovering entry neither escalates nor fails gh-aging', () => {
  // USGS down 18:00-19:55 (the logic review's t3): at 20:07 it is absent, its row open for 1 of 2 healthy runs.
  const w = new World();
  const S = T('2026-10-04T18:00:00Z');
  const usgs = (nowMs: number): Finding => f('alerts:provider:usgs', { severity: nowMs - S >= 30 * MIN ? 'P3' : 'P4', sinceMs: S, text: 'usgs down' });
  for (const iso of every15('2026-10-04T18:07:00Z', '2026-10-04T19:52:00Z')) w.run(iso, { alerts: [usgs(T(iso))] });
  const r = w.run('2026-10-04T20:07:00Z', {});
  assert.equal(w.entry('alerts:provider:usgs')!.open, true);
  assert.equal(w.entry('alerts:provider:usgs')!.escalated, false);
  assert.deepEqual(r.comments, []);
  assert.deepEqual(signal(r, 'gh-aging'), ['success']);
  // Back at 20:22 (present again, 2.4 h into the episode): it escalates now.
  const back = w.run('2026-10-04T20:22:00Z', { alerts: [usgs(T('2026-10-04T20:22:00Z'))] });
  assert.match(back.comments[0]!.body, /— open for 2\.3 h: /);
});

test('only an entry open after this run\'s holds inhibits: a pending first sample shown as P4 mutes nothing', () => {
  const w = new World();
  const unreachable = f('feed:freshness:unreachable', { members: ['v2'], text: 'v2/manifest.json unreachable after 4 tries' });
  const r = w.run('2026-10-21T10:07:00Z', { feed: [unreachable, tmd()] });
  assert.equal(w.entry('feed:freshness')!.pending, 'confirming 1/2');
  assert.equal(w.entry('feed:source:tmd')!.muted, null);
  assert.match(r.comments[0]!.body, /`feed:source:tmd`/);
  // Confirmed on the second run, it inhibits (a new source entering then is muted).
  w.run('2026-10-21T10:22:00Z', { feed: [unreachable, tmd(), f('feed:source:definite', { id: 'kagsr', sinceMs: T('2026-10-21T08:00:00Z'), text: 'kagsr HTTP 404' })] });
  assert.deepEqual(w.entry('feed:source:kagsr')!.muted, { by: 'inhibited', note: 'inhibited by feed:freshness' });
});

test('gh-aging: an announced escalation keeps it failing through a mute, so the unmute pushes nothing new', () => {
  const w = new World();
  const S = T('2026-10-04T18:07:00Z');
  const usgs = (nowMs: number): Finding => f('alerts:provider:usgs', { severity: nowMs - S >= 30 * MIN ? 'P3' : 'P4', sinceMs: S, text: 'usgs ok:false' });
  const cov = f('alerts:coverage:two', { sinceMs: T('2026-10-04T20:15:00Z'), members: ['usgs', 'emsc'], text: 'usgs and emsc failing together' });
  for (const iso of every15('2026-10-04T18:22:00Z', '2026-10-04T20:07:00Z')) w.run(iso, { alerts: [usgs(T(iso))] });
  assert.equal(w.entry('alerts:provider:usgs')!.escalationNotified, true);
  for (const iso of every15('2026-10-04T20:22:00Z', '2026-10-04T21:52:00Z')) {
    const muted = T(iso) <= T('2026-10-04T21:07:00Z');
    const r = w.run(iso, { alerts: muted ? [usgs(T(iso)), cov] : [usgs(T(iso))] });
    assert.deepEqual(signal(r, 'gh-aging'), ['fail'], iso);
    if (T(iso) <= T('2026-10-04T21:22:00Z')) assert.equal(w.entry('alerts:provider:usgs')!.muted?.by, 'inhibited', iso);
  }
  assert.equal(w.entry('alerts:provider:usgs')!.muted, null);
  // gh-aging went to /fail once (20:07) and gh-redundancy once (20:22): two would-be pushes, not three.
  assert.equal(w.state('alerts')!.days['2026-10-04']!.transitions, 2);
});

test('samples and confirmations go by time: a run within 10 min of the last shares its slot; a confirming run comes 10 min after the first', () => {
  // An extra dispatch at 12:54 adds no sample: 4 of 8 is reached at 13:37, as without it (not at 13:22).
  const w = new World();
  const since = T('2026-10-21T12:50:00Z');
  for (const iso of ['2026-10-21T12:52:00Z', '2026-10-21T12:54:00Z', '2026-10-21T13:07:00Z', '2026-10-21T13:22:00Z']) w.run(iso, { alerts: [gfz('P4', since)] });
  assert.equal(w.entry('alerts:provider:gfz')!.samples, '111');
  assert.equal(w.entry('alerts:provider:gfz')!.open, false);
  w.run('2026-10-21T13:37:00Z', { alerts: [gfz('P4', since)] });
  assert.equal(w.entry('alerts:provider:gfz')!.open, true);
  // A slot is present when either run in it saw the key, dated by the run that saw it.
  const v = new World();
  v.run('2026-10-21T12:52:00Z', { alerts: [gfz('P4', since)] });
  v.run('2026-10-21T13:07:00Z', {});
  v.run('2026-10-21T13:11:00Z', { alerts: [gfz('P4', since)] });
  assert.equal(v.entry('alerts:provider:gfz')!.samples, '11');
  assert.deepEqual(v.entry('alerts:provider:gfz')!.sampleMs, [T('2026-10-21T12:52:00Z'), T('2026-10-21T13:11:00Z')]);

  // A rerun 2 min later does not confirm a 2-run rule: status.json unreadable stays P4 (green) until 10:22.
  const u = new World();
  const unreadable = f('alerts:status:unreadable', { text: 'cannot read status.json: HTTP 522 after 3 attempt(s)' });
  assert.equal(u.run('2026-10-21T10:07:00Z', { alerts: [unreadable] }, { unjudged: { alerts: ['alerts:*'] } }).exitCode, 0);
  const quick = u.run('2026-10-21T10:09:00Z', { alerts: [unreadable] }, { unjudged: { alerts: ['alerts:*'] } });
  assert.equal(quick.exitCode, 0);
  assert.equal(u.entry('alerts:status:unreadable')!.pending, 'confirming 1/2');
  assert.equal(u.run('2026-10-21T10:22:00Z', { alerts: [unreadable] }, { unjudged: { alerts: ['alerts:*'] } }).exitCode, 1);
});

test('selftest tracking: recorded on the boards; 35 days without one (boards older than that) opens watcher:selftest-overdue with one comment', () => {
  const w = new World();
  w.run('2026-10-01T10:07:00Z', {});
  assert.equal(w.state('alerts')!.lastSelftestMs, null);
  w.run('2026-11-05T10:07:00Z', {});
  assert.equal(w.entry('watcher:selftest-overdue'), undefined, '35 days exactly is not over the line');
  w.run('2026-11-05T10:22:00Z', {});
  assert.equal(w.entry('watcher:selftest-overdue')!.pending, 'confirming 1/2');
  assert.match(w.entry('watcher:selftest-overdue')!.text, /^no selftest since the boards were created at 2026-10-01 10:07Z \(35\.0 d; line 35\.0 d\): GitHub may have dropped the monthly selftest cron/);
  const r = w.run('2026-11-05T10:37:00Z', {});
  assert.equal(r.exitCode, 0, 'a watcher fault is never red');
  assert.match(r.comments[0]!.body, /^\*\*P3 · `watcher:selftest-overdue`\*\* watcher fault — /);
  assert.equal(w.run('2026-11-05T10:52:00Z', {}).comments.length, 0, 'one comment');
  // A selftest run (red, as designed) records itself and resolves the row.
  const st = w.run('2026-11-05T11:07:00Z', { alerts: [f('alerts:selftest', { text: 'forced by the selftest' })] });
  assert.equal(st.exitCode, 1);
  assert.equal(w.entry('watcher:selftest-overdue'), undefined);
  assert.equal(w.state('feed')!.lastSelftestMs, T('2026-11-05T11:07:00Z'));
  // 35 days after it, overdue again.
  w.run('2026-12-10T11:22:00Z', {});
  assert.match(w.entry('watcher:selftest-overdue')!.text, /^the last selftest ran at 2026-11-05 11:07Z/);
  // At rollout nothing is overdue, whatever the clock says.
  const v = new World();
  v.run('2027-06-01T10:07:00Z', {});
  v.run('2027-06-01T10:22:00Z', {});
  assert.equal(v.entry('watcher:selftest-overdue'), undefined);
});

test('promotion: status.json unreadable for 60 min becomes P1 (red on every run, gh-detect) while every other alerts:* key stays frozen', () => {
  const w = new World();
  const unreadable = f('alerts:status:unreadable', { text: 'cannot read status.json: HTTP 404 after 3 attempt(s)' });
  const run = (iso: string): ReconcileResult => w.run(iso, { alerts: [unreadable] }, { unjudged: { alerts: ['alerts:*'] } });
  run('2026-10-21T10:07:00Z');
  const want: Record<string, [Severity, number, string]> = {
    '10:22': ['P2', 1, 'gh-platform'],
    '10:37': ['P2', 1, 'gh-platform'],
    '11:07': ['P2', 1, 'gh-platform'],
    '11:22': ['P1', 1, 'gh-detect'],
    '11:37': ['P1', 1, 'gh-detect'],
    '13:37': ['P1', 1, 'gh-detect'],
  };
  for (const [hm, [sev, exit, check]] of Object.entries(want)) {
    const r = run(`2026-10-21T${hm}:00Z`);
    assert.equal(w.entry('alerts:status:unreadable')!.severity, sev, hm);
    assert.equal(r.exitCode, exit, hm);
    assert.deepEqual(failing(r), [check], hm);
    // The promotion is silent: the red run tells the owner, the public board's watchers get no P1 comment.
    assert.deepEqual(r.comments, [], hm);
  }
  assert.equal(w.run('2026-10-21T13:52:00Z', { alerts: [] }).exitCode, 0);
  assert.equal(w.entry('alerts:status:unreadable'), undefined);
});

test('a P1/P2 held open by a P4 sample below its line is not red and fails no check, and stays one episode', () => {
  // The verify replay's N5c: usgs, emsc and gfz down 10:00-10:20, then only usgs and gfz until 12:30. coverage:all stays
  // open on its P4 samples (it resolves once two providers are ok), but all three are no longer down.
  const w = new World();
  const S = T('2026-10-22T10:00:00Z');
  const all = f('alerts:coverage:all', { sinceMs: S, members: ['usgs', 'emsc', 'gfz'], text: 'all three direct providers have been failing together for 7 min' });
  const below = f('alerts:coverage:all', { severity: 'P4', sinceMs: S, members: ['usgs', 'gfz'], text: '2 of the 3 direct providers are failing (usgs, gfz): below the all-three line' });
  const r1 = w.run('2026-10-22T10:07:00Z', { alerts: [all] });
  assert.equal(r1.exitCode, 1);
  assert.deepEqual(signal(r1, 'gh-detect'), ['fail']);
  for (const iso of every15('2026-10-22T10:22:00Z', '2026-10-22T12:22:00Z')) {
    const r = w.run(iso, { alerts: [below] });
    assert.equal(r.exitCode, 0, iso);
    assert.deepEqual(signal(r, 'gh-detect'), ['success'], iso);
    assert.deepEqual([w.entry('alerts:coverage:all')!.open, w.entry('alerts:coverage:all')!.severity], [true, 'P1'], `${iso}: open until it resolves`);
  }
  assert.match(w.bodies.alerts!, /below its line this run: not red, open until it resolves/);
  // All three down again: red at once, in the same episode (one open event).
  const again = w.run('2026-10-22T12:37:00Z', { alerts: [all] });
  assert.equal(again.exitCode, 1);
  assert.deepEqual(signal(again, 'gh-detect'), ['fail']);
  w.run('2026-10-22T12:52:00Z', {});
  assert.equal(w.entry('alerts:coverage:all'), undefined);
  assert.equal(w.state('alerts')!.log.filter((x) => x.key === 'alerts:coverage:all' && x.event === 'open').length, 1);
  assert.equal(w.comments.length, 0);

  // A P2 in its P4 band (the budget projected between 0.65 and 0.75) is green inside its first hour too.
  const v = new World();
  const budget = (severity: Severity): Finding => f('alerts:budget', { severity, members: ['doRowsWritten'], text: `rows written projected (${severity})` });
  assert.equal(v.run('2026-10-22T10:07:00Z', { alerts: [budget('P2')] }).exitCode, 1);
  const band = v.run('2026-10-22T10:22:00Z', { alerts: [budget('P4')] });
  assert.equal(band.exitCode, 0);
  assert.deepEqual(signal(band, 'gh-capacity'), ['success']);
  assert.equal(v.run('2026-10-22T10:37:00Z', { alerts: [budget('P2')] }).exitCode, 1, 'over the line again inside its first hour');
});

test('resolving goes by time too: an absent run within 10 min of the previous sample adds no healthy run', () => {
  // The verify replay's t5 A: USGS down from 08:00; a 3-min recovery seen by the 10:07 run and by a second dispatch 40 s
  // later. The episode goes on, and its 2 h escalation comes at 10:22 (it was resolved, then re-entered at 10:52).
  const w = new World();
  const S = T('2026-10-22T08:00:00Z');
  const usgs = (iso: string, since = S): Finding => f('alerts:provider:usgs', { severity: T(iso) - since >= 30 * MIN ? 'P3' : 'P4', sinceMs: since, text: 'usgs down' });
  for (const iso of every15('2026-10-22T08:07:00Z', '2026-10-22T09:52:00Z')) w.run(iso, { alerts: [usgs(iso)] });
  w.run('2026-10-22T10:07:00Z', {});
  w.run('2026-10-22T10:07:40Z', {});
  assert.deepEqual([w.entry('alerts:provider:usgs')!.open, w.entry('alerts:provider:usgs')!.absentRuns], [true, 1], 'one healthy slot of the 2 it needs');
  const back = w.run('2026-10-22T10:22:00Z', { alerts: [usgs('2026-10-22T10:22:00Z', T('2026-10-22T10:09:00Z'))] });
  assert.match(back.comments[0]!.body, /^\*\*P3 · `alerts:provider:usgs`\*\* USGS failing — open for 2\.3 h: usgs down \(since 2026-10-22 08:00Z, 2\.3 h\)/);
  assert.equal(w.comments.length, 2, 'the entry and its escalation, nothing else');

  // A P2 open since 10:07: the runs at 10:37 and 10:38 are one healthy slot, so it resolves at 10:52, not at 10:38.
  const v = new World();
  const cov = f('alerts:coverage:two', { sinceMs: T('2026-10-22T10:03:00Z'), members: ['emsc', 'gfz'], text: 'emsc and gfz failing together' });
  v.run('2026-10-22T10:07:00Z', { alerts: [cov] });
  v.run('2026-10-22T10:22:00Z', { alerts: [cov] });
  v.run('2026-10-22T10:37:00Z', {});
  v.run('2026-10-22T10:38:00Z', {});
  assert.equal(v.entry('alerts:coverage:two')!.open, true);
  v.run('2026-10-22T10:52:00Z', {});
  assert.equal(v.entry('alerts:coverage:two'), undefined);
});

test('a direct provider the gateway stopped polling is on the board, and with the others failing it is the P1 on every run', () => {
  // The logic review's case: gfz missing from detector.providers while usgs, emsc and the feed backstop fail. It used
  // to freeze every coverage row and give a P2 red for one hour, then green for good with nothing on any board.
  const doc = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'alerts-status', 'healthy.json'), 'utf8')) as Record<string, any>;
  const at = (nowMs: number, failing: boolean): Record<string, any> => {
    const d = structuredClone(doc);
    const delta = nowMs - 15 * SEC - (d.generatedAtMs as number);
    d.generatedAtMs += delta;
    d.detector.providers = d.detector.providers.filter((p: { id: string }) => p.id !== 'gfz');
    for (const p of d.detector.providers) {
      if (!failing) continue;
      Object.assign(p, { ok: false, consecutiveFailures: 40, lastError: 'timeout', failingSinceMs: T('2026-10-22T19:40:00Z') });
    }
    return d;
  };
  const w = new World();
  const runs = every15('2026-10-22T19:52:00Z', '2026-10-22T22:52:00Z');
  for (const iso of runs) {
    const v = evaluateStatus(at(T(iso), true), { nowMs: T(iso), canary: null });
    const r = w.run(iso, { alerts: v.findings }, { unjudged: { alerts: v.unjudged } });
    assert.equal(r.exitCode, 1, iso);
    assert.match(r.summary, /P1 `alerts:coverage:all`/, iso);
    assert.deepEqual(signal(r, 'gh-detect'), ['fail'], iso);
  }
  const gfz = w.entry('alerts:provider:gfz')!;
  assert.deepEqual([gfz.open, gfz.rule, gfz.severity], [true, 'alerts:provider:unlisted', 'P3']);
  assert.deepEqual(gfz.muted, { by: 'inhibited', note: 'inhibited by alerts:coverage:all' }, 'one notice per group');
  assert.match(w.bodies.alerts!, /`alerts:provider:gfz` \|[^\n]*direct provider not polled/);
  // The providers back, gfz still not polled: its own P3 row comments once the coverage rows have resolved.
  for (const iso of every15('2026-10-22T23:07:00Z', '2026-10-22T23:52:00Z')) {
    const v = evaluateStatus(at(T(iso), false), { nowMs: T(iso), canary: null });
    const r = w.run(iso, { alerts: v.findings }, { unjudged: { alerts: v.unjudged } });
    assert.equal(r.exitCode, 0, iso);
  }
  assert.equal(w.entry('alerts:coverage:all'), undefined);
  assert.deepEqual(w.comments.map((c) => `${c.at} ${c.body.split(' — ')[0]}`), [
    '2026-10-22 20:22Z **P3 · `alerts:provider:feed`** gateway feed backstop failing',
    '2026-10-22 23:22Z **P3 · `alerts:provider:gfz`** direct provider not polled',
  ]);
});

test('body: 100 open rows still fit (the marker leaves out derived and blank fields; the tables shrink last), and round-trip', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `src${String(i).padStart(3, '0')}`);
  const many = ids.map((id) => f('feed:source', { id, members: ['fetch'], sinceMs: T('2026-10-20T00:00:00Z'), text: `${id}: fetch failing for 34.1 h, error: ${'upstream connect error or disconnect/reset before headers '.repeat(4)}` }));
  const w = new World();
  for (const iso of every15('2026-10-21T10:07:00Z', '2026-10-21T11:52:00Z')) w.run(iso, { feed: many });
  const st = w.state('feed')!;
  assert.equal(Object.values(st.entries).filter((e) => e.open && e.notified === 'P3').length, 100, 'every row and its memory kept');
  assert.match(w.bodies.feed!, /\n\d+ more row\(s\) are kept in the state only \(the run's job summary lists them\)\./);
  const entries = w.bodies.feed!.slice(w.bodies.feed!.lastIndexOf('"entries":'));
  assert.ok(!entries.includes('"board":') && !entries.includes('"class":') && !entries.includes('"frozen":null'), 'no derived or blank field');
});

// ---------------------------------------------------------------------------------------------------------
// The I/O wrapper against a fake GitHub

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  locked: boolean;
  pinned: boolean;
  labels: string[];
  node_id: string;
  pull_request?: { url: string };
  comments: string[];
}
interface Call {
  method: string;
  url: string;
  body: unknown;
}
interface FakeRun {
  created_at: string;
  status?: string;
  conclusion?: string | null;
}

class FakeGitHub {
  issues: FakeIssue[] = [];
  calls: Call[] = [];
  labels = new Set<string>(LABEL_DEFS.map((l) => l.name));
  listStatus: number[] = [];
  patchStatus = 200;
  pingStatus = 200;
  /** The status of the next comment POSTs, one per try (then 201). */
  commentStatus: number[] = [];
  /** Whether GITHUB_TOKEN may comment on a locked issue is unverified: 0 accepts it, 403 or 422 refuses it as locked. */
  lockedRejectsComments: 0 | 403 | 422 = 0;
  /** The same for editing a locked issue's body. */
  lockedRejectsPatch: 0 | 403 | 422 = 0;
  /** GitHub drops the labels of a new issue silently for a token without push access. */
  dropLabelsOnCreate = false;
  labelsStatus = 200;
  lockStatus = 204;
  graphqlStatus = 200;
  dispatched: FakeRun[] = [];
  runsStatus = 200;
  nextNumber = 100;

  board(title: string): FakeIssue | undefined {
    return this.issues.find((i) => i.title === title && !i.pull_request);
  }

  fetchImpl: FetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body ?? null;
    if (url.startsWith('https://api.github.com') && typeof body === 'string') body = JSON.parse(body);
    this.calls.push({ method, url, body });
    const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith(HC_PING_BASE)) return new Response('OK', { status: this.pingStatus });
    const path = url.replace('https://api.github.com', '');
    const b = body as Record<string, unknown> | null;
    if (method === 'GET' && path === `/repos/${REPO}/issues?labels=health-board&state=all&per_page=100`) {
      const status = this.listStatus.shift() ?? 200;
      if (status !== 200) return json({ message: 'boom' }, status);
      return json(
        this.issues
          .filter((i) => i.labels.includes('health-board'))
          .map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, locked: i.locked, labels: i.labels.map((name) => ({ name })), node_id: i.node_id, ...(i.pull_request ? { pull_request: i.pull_request } : {}) })),
      );
    }
    if (method === 'GET' && path.startsWith(`/repos/${REPO}/actions/workflows/health.yml/runs?event=workflow_dispatch`)) {
      if (this.runsStatus !== 200) return json({ message: 'boom' }, this.runsStatus);
      return json({ workflow_runs: this.dispatched.map((r, i) => ({ id: i, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', ...r })) });
    }
    if (method === 'POST' && path === `/repos/${REPO}/issues`) {
      const labels = (b!['labels'] as string[]) ?? [];
      if (labels.some((l) => !this.labels.has(l))) return json({ message: 'Validation Failed' }, 422);
      const issue: FakeIssue = { number: this.nextNumber++, title: String(b!['title']), body: String(b!['body']), state: 'open', locked: false, pinned: false, labels: this.dropLabelsOnCreate ? [] : labels, node_id: `I_${this.nextNumber}`, comments: [] };
      this.issues.push(issue);
      return json({ number: issue.number, node_id: issue.node_id, labels: issue.labels.map((name) => ({ name })) }, 201);
    }
    if (method === 'POST' && path === `/repos/${REPO}/labels`) {
      const name = String(b!['name']);
      if (this.labels.has(name)) return json({ message: 'already_exists' }, 422);
      this.labels.add(name);
      return json({ name }, 201);
    }
    if (method === 'POST' && path === '/graphql') {
      if (this.graphqlStatus !== 200) return json({ message: 'Resource not accessible by integration' }, this.graphqlStatus);
      const query = String(b!['query']);
      const vars = b!['variables'] as { issueId?: string; ids?: string[] };
      if (query.includes('pinIssue')) {
        const issue = this.issues.find((i) => i.node_id === vars.issueId);
        if (issue) issue.pinned = true;
        return json({ data: { pinIssue: { issue: { number: issue?.number ?? null } } } });
      }
      return json({ data: { nodes: (vars.ids ?? []).map((id) => this.issues.find((i) => i.node_id === id)).map((i) => (i ? { id: i.node_id, number: i.number, isPinned: i.pinned, locked: i.locked } : null)) } });
    }
    const m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/[a-z]+)?$/.exec(path);
    const issue = m ? this.issues.find((i) => i.number === Number(m[1])) : undefined;
    if (m && issue) {
      if (method === 'PATCH' && !m[2]) {
        if (this.patchStatus !== 200) return json({ message: 'boom' }, this.patchStatus);
        if (this.lockedRejectsPatch !== 0 && issue.locked) return json({ message: 'Issue is locked' }, this.lockedRejectsPatch);
        if (typeof b?.['body'] === 'string') issue.body = b['body'];
        if (b?.['state'] === 'open' || b?.['state'] === 'closed') issue.state = b['state'];
        return json({ number: issue.number });
      }
      if (method === 'PUT' && m[2] === '/lock') {
        if (this.lockStatus !== 204) return json({ message: 'boom' }, this.lockStatus);
        issue.locked = true;
        return new Response(null, { status: 204 });
      }
      if (method === 'DELETE' && m[2] === '/lock') {
        issue.locked = false;
        return new Response(null, { status: 204 });
      }
      if (method === 'PUT' && m[2] === '/labels') {
        if (this.labelsStatus !== 200) return json({ message: 'boom' }, this.labelsStatus);
        issue.labels = [...(b!['labels'] as string[])];
        return json(issue.labels.map((name) => ({ name })));
      }
      if (method === 'POST' && m[2] === '/comments') {
        const status = this.commentStatus.shift();
        if (status !== undefined && status !== 201) return json({ message: 'boom' }, status);
        if (this.lockedRejectsComments !== 0 && issue.locked) return json({ message: 'Unable to create comment because issue is locked.' }, this.lockedRejectsComments);
        issue.comments.push(String(b!['body']));
        return json({ id: 1 }, 201);
      }
    }
    return json({ message: 'Not Found' }, 404);
  };

  writes(): Call[] {
    return this.calls.filter((c) => c.method !== 'GET' && !c.url.startsWith(HC_PING_BASE));
  }
}

const callText = (c: Call): string => `${c.method} ${c.url.replace('https://api.github.com', '')}`;

const ENV = { GH_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '42', GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_NAME: 'workflow_dispatch' };

/** An in-memory findings directory. */
function findingsDir(docs: FindingsDocument[], extra: Record<string, string> = {}): { readDir: (p: string) => string[]; readFile: (p: string) => string } {
  const files = new Map<string, string>();
  for (const d of docs) files.set(`findings/${d.evaluator}.json`, JSON.stringify(d));
  for (const [k, v] of Object.entries(extra)) files.set(`findings/${k}`, v);
  return {
    readDir: (p) => {
      if (p !== 'findings') throw new Error(`ENOENT: ${p}`);
      return [...files.keys()].map((k) => k.slice('findings/'.length));
    },
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
  };
}

const docsAt = (nowMs: number, findings: Findings): FindingsDocument[] => new World().docs(nowMs, findings);

async function runMain(gh: FakeGitHub, nowMs: number, findings: Findings, opts: { env?: Record<string, string>; argv?: string[]; extra?: Record<string, string> } = {}): Promise<{ code: number; lines: string[]; sleeps: number[]; summary: string[] }> {
  const lines: string[] = [];
  const sleeps: number[] = [];
  const summary: string[] = [];
  const code = await main({
    argv: opts.argv ?? ['--findings-dir', 'findings'],
    env: { ...ENV, GITHUB_STEP_SUMMARY: '/summary', ...(opts.env ?? {}) },
    fetchImpl: gh.fetchImpl,
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (l) => lines.push(l),
    appendFile: (_p, s) => summary.push(s),
    ...findingsDir(docsAt(nowMs, findings), opts.extra),
  });
  return { code, lines, sleeps, summary };
}

test('main: the first run creates all three boards, the labels first, each pinned and locked; a comment goes before its body; only a deleted board is created again', async () => {
  const gh = new FakeGitHub();
  gh.labels = new Set();
  const first = await runMain(gh, T('2026-10-21T10:07:00Z'), {});
  assert.equal(first.code, 0);
  assert.deepEqual(gh.writes().map(callText), [
    ...LABEL_DEFS.map(() => `POST /repos/${REPO}/labels`),
    ...[100, 101, 102].flatMap((n) => [`POST /repos/${REPO}/issues`, 'POST /graphql', `PUT /repos/${REPO}/issues/${n}/lock`]),
  ]);
  assert.deepEqual([...gh.labels].sort(), LABEL_DEFS.map((l) => l.name).sort());
  assert.deepEqual(
    gh.issues.map((i) => [i.number, i.title, i.locked, i.pinned, i.labels.join(' '), i.comments.length]),
    [
      [100, '[health] alert pipeline', true, true, 'health-board health:ok', 0],
      [101, '[health] feed', true, true, 'health-board health:ok', 0],
      [102, '[health] platform', true, true, 'health-board health:ok', 0],
    ],
  );
  assert.equal(parseBoardState(gh.issues[0]!.body, 'alerts')!.createdMs, T('2026-10-21T10:07:00Z'));
  assert.ok(first.lines.includes('pings skipped (HC_PING_KEY unset)'));
  assert.ok(first.summary.join('').includes('**Run verdict: green.**'));

  // A P3 entry: its comment first, then the bodies (and the new label); no board is created by a finding.
  gh.calls = [];
  const second = await runMain(gh, T('2026-10-21T10:22:00Z'), { feed: [tmd()] });
  assert.equal(second.code, 0);
  assert.deepEqual(gh.writes().map(callText), [
    `POST /repos/${REPO}/issues/101/comments`,
    `PATCH /repos/${REPO}/issues/100`,
    `PATCH /repos/${REPO}/issues/101`,
    `PUT /repos/${REPO}/issues/101/labels`,
    `PATCH /repos/${REPO}/issues/102`,
  ]);
  const board = gh.board('[health] feed')!;
  assert.deepEqual(board.labels, ['health-board', 'health:p3']);
  assert.equal(board.comments.length, 1);
  assert.match(board.comments[0]!, /Run: https:\/\/github\.com\/TheShelterApp\/earthquakes-feed\/actions\/runs\/42$/);
  assert.equal(parseBoardState(board.body, 'feed')!.entries['feed:source:tmd']!.notified, 'P3');

  // A board deleted by hand comes back on the next run, whatever that run judges.
  gh.issues = gh.issues.filter((i) => i.number !== 102);
  gh.calls = [];
  await runMain(gh, T('2026-10-21T10:37:00Z'), { feed: [tmd()] });
  assert.equal(gh.calls.filter((c) => callText(c) === `POST /repos/${REPO}/issues`).length, 1);
  assert.equal(gh.board('[health] platform')!.number, 103);
  assert.equal(gh.issues.length, 3);
});

test('main: duplicates use the lowest number; a closed board with an open entry reopens; an unlocked board is locked again', async () => {
  const dup = new FakeGitHub();
  const seed = (number: number, state: 'open' | 'closed', body = ''): FakeIssue => ({ number, title: '[health] feed', body, state, locked: true, pinned: true, labels: ['health-board', 'health:ok', 'documentation'], node_id: `I_${number}`, comments: [] });
  dup.issues.push(seed(7, 'open'), seed(3, 'closed'), { ...seed(5, 'open'), title: '[health] feed', pull_request: { url: 'x' } });
  const out = await runMain(dup, T('2026-10-21T10:07:00Z'), { feed: [tmd()] });
  const patch = dup.calls.find((c) => c.method === 'PATCH')!;
  assert.match(patch.url, /\/issues\/3$/);
  assert.equal((patch.body as { state?: string }).state, 'open', 'reopened: it has an open entry');
  assert.equal(dup.issues.find((i) => i.number === 3)!.state, 'open');
  assert.deepEqual(dup.issues.find((i) => i.number === 3)!.labels, ['health-board', 'health:p3', 'documentation'], 'a hand-added label stays');
  assert.equal(dup.issues.find((i) => i.number === 3)!.comments.length, 1);
  assert.ok(out.lines.some((l) => l.startsWith('::warning title=Health reconcile::2 issues are titled "[health] feed" (#3, #7): using #3')));
  assert.deepEqual(dup.issues.filter((i) => i.title !== '[health] feed').map((i) => i.title), ['[health] alert pipeline', '[health] platform'], 'the two missing boards');

  const un = new FakeGitHub();
  un.issues.push({ ...seed(9, 'closed'), locked: false });
  await runMain(un, T('2026-10-21T10:07:00Z'), {});
  assert.equal(un.issues[0]!.locked, true);
  assert.equal(un.issues[0]!.state, 'closed', 'no open entry: it stays closed');
  assert.ok(parseBoardState(un.issues[0]!.body, 'feed'), 'the body was rewritten with a state marker');
});

test('main: unreadable boards, or GH_TOKEN unset, write nothing, send no pings and exit 3, naming the P1/P2 findings present', async () => {
  const gh = new FakeGitHub();
  gh.listStatus = [502, 502, 502];
  const p3 = await runMain(gh, T('2026-10-21T10:07:00Z'), { feed: [tmd()] }, { env: { HC_PING_KEY: 'k3y-SECRET' } });
  assert.equal(p3.code, 3, 'alerting itself is broken: the prior state is unknown');
  assert.deepEqual(p3.sleeps, [2_000, 5_000]);
  assert.deepEqual(gh.writes(), []);
  assert.equal(gh.calls.filter((c) => c.url.startsWith(HC_PING_BASE)).length, 0);
  assert.ok(p3.lines.some((l) => l.startsWith('::error::boards unreadable (HTTP 502')));
  gh.listStatus = [500, 500, 500];
  const urgent = await runMain(gh, T('2026-10-21T10:22:00Z'), { alerts: [f('alerts:policy', { text: 'fallback policy' })], platform: [f('platform:api', { text: 'api down' })] });
  assert.equal(urgent.code, 3);
  assert.match(urgent.summary.join(''), /the run is red \(exit 3: alerting itself is broken\); P1\/P2 findings present this run: P1 `alerts:policy`, P2 `platform:api`\./);
  assert.ok(urgent.lines.some((l) => l.startsWith('::error title=P2 platform%3Aapi::api down')));
  gh.listStatus = [403];
  assert.equal((await runMain(gh, T('2026-10-21T10:37:00Z'), { alerts: [f('alerts:canary', { text: 'canary' })] })).code, 3);

  const unset = await runMain(new FakeGitHub(), T('2026-10-21T10:07:00Z'), {}, { env: { GH_TOKEN: '' } });
  assert.equal(unset.code, 3);
  assert.ok(unset.lines.some((l) => l.includes('boards unreadable (GH_TOKEN or GITHUB_REPOSITORY unset (misconfigured))')));
});

test('main: a body that cannot be saved after its retries exits 3; its comment went out first, so the next run may repeat it, never lose it', async () => {
  const w = new FakeGitHub();
  await runMain(w, T('2026-10-21T10:07:00Z'), { feed: [tmd()] });
  assert.equal(w.board('[health] feed')!.comments.length, 1);
  w.patchStatus = 500;
  w.calls = [];
  const kagsr = f('feed:source:definite', { id: 'kagsr', sinceMs: T('2026-10-21T08:15:00Z'), members: ['fetch'], text: 'kagsr HTTP 404 for 2.1 h' });
  const out = await runMain(w, T('2026-10-21T10:22:00Z'), { feed: [tmd(), kagsr] });
  assert.equal(out.code, 3);
  assert.equal(w.calls.filter((c) => callText(c) === `PATCH /repos/${REPO}/issues/101`).length, 3, 'retried on 5xx');
  assert.equal(w.board('[health] feed')!.comments.length, 2, 'the kagsr comment went out before the body');
  assert.ok(out.lines.some((l) => l.startsWith('::error title=Health reconcile::cannot update board #101: HTTP 500')));
  assert.ok(out.lines.includes('reconcile: the run is red (a board could not be written)'));
  w.patchStatus = 200;
  const again = await runMain(w, T('2026-10-21T10:37:00Z'), { feed: [tmd(), kagsr] });
  assert.equal(again.code, 0);
  assert.equal(w.board('[health] feed')!.comments.length, 3, 'the saved state never recorded it: posted again');
  assert.equal(parseBoardState(w.board('[health] feed')!.body, 'feed')!.entries['feed:source:kagsr']!.notified, 'P3');
});

test('main: a comment that still fails after 3 tries is an ::error::, rolled back so the next run posts it again (watcher:reconcile); failing on two runs in a row exits 3', async () => {
  const gh = new FakeGitHub();
  await runMain(gh, T('2026-10-21T10:07:00Z'), {});
  gh.commentStatus = [502, 502, 502];
  gh.calls = [];
  const r1 = await runMain(gh, T('2026-10-21T10:22:00Z'), { feed: [tmd()] });
  assert.equal(r1.code, 0, 'a comment is not the board state: the run keeps its verdict');
  const order = gh.writes().map(callText);
  assert.deepEqual(order.slice(0, 3), Array(3).fill(`POST /repos/${REPO}/issues/101/comments`));
  assert.deepEqual(r1.sleeps, [2_000, 5_000]);
  assert.ok(order.indexOf(`PATCH /repos/${REPO}/issues/101`) > 2, 'the body after the comment');
  assert.ok(r1.lines.some((l) => l.startsWith('::error title=Health reconcile::cannot comment on board "[health] feed": HTTP 502') && l.includes('feed:source:tmd rolled back')));
  const feed = parseBoardState(gh.board('[health] feed')!.body, 'feed')!;
  assert.equal(feed.entries['feed:source:tmd']!.open, true);
  assert.equal(feed.entries['feed:source:tmd']!.notified, null, 'rolled back');
  assert.equal(feed.entries['feed:source:tmd']!.retryComment, true);
  assert.equal(feed.days['2026-10-21']!.comments, 0);
  assert.deepEqual(feed.log.map((x) => x.event), ['open'], 'the notify event is taken back');
  assert.deepEqual(parseBoardState(gh.board('[health] platform')!.body, 'platform')!.faults, [{ ms: T('2026-10-21T10:22:00Z'), text: '"[health] feed": HTTP 502: {"message":"boom"}' }]);

  // It fails again on the next run: watcher:reconcile is seen once (P4), the failure is recorded again, and the run is
  // red (exit 3): watcher:reconcile's own comment could not reach anyone either.
  gh.commentStatus = [502, 502, 502];
  const r2 = await runMain(gh, T('2026-10-21T10:37:00Z'), { feed: [tmd()] });
  assert.equal(r2.code, 3);
  assert.ok(r2.lines.some((l) => l.startsWith('::error title=Health reconcile::board comments failed on two runs in a row (1 on the last run, 1 on this one)')));
  assert.ok(r2.lines.includes('reconcile: the run is red (board comments failed on two runs in a row)'));
  const watcher = parseBoardState(gh.board('[health] platform')!.body, 'platform')!.entries['watcher:reconcile']!;
  assert.equal(watcher.pending, 'confirming 1/2');
  assert.match(watcher.text, /^the last health run could not post a board comment \(rolled back, so this run posts it again\): "\[health\] feed": HTTP 502/);
  assert.equal(gh.board('[health] feed')!.comments.length, 0);

  // Comments work again: the tmd entry comment goes out, and watcher:reconcile (2 runs in a row) opens with its own.
  const r3 = await runMain(gh, T('2026-10-21T10:52:00Z'), { feed: [tmd()] });
  assert.equal(r3.code, 0, 'the watcher is never red');
  assert.equal(gh.board('[health] feed')!.comments.length, 1);
  assert.match(gh.board('[health] feed')!.comments[0]!, /^\*\*P3 · `feed:source:tmd`\*\*/);
  assert.match(gh.board('[health] platform')!.comments[0]!, /^\*\*P3 · `watcher:reconcile`\*\* watcher fault — /);
  const after = parseBoardState(gh.board('[health] platform')!.body, 'platform')!;
  assert.deepEqual(after.faults, []);
  assert.equal(parseBoardState(gh.board('[health] feed')!.body, 'feed')!.entries['feed:source:tmd']!.retryComment, false);
  // The next run without a failure resolves it.
  await runMain(gh, T('2026-10-21T11:07:00Z'), { feed: [tmd()] });
  assert.equal(parseBoardState(gh.board('[health] platform')!.body, 'platform')!.entries['watcher:reconcile'], undefined);
});

test('main: a board locked against the bot\'s comment (403, or a 422 that says so) is unlocked, commented and locked again', async () => {
  for (const status of [403, 422] as const) {
    const gh = new FakeGitHub();
    gh.lockedRejectsComments = status;
    await runMain(gh, T('2026-10-21T10:07:00Z'), {});
    gh.calls = [];
    const r = await runMain(gh, T('2026-10-21T10:22:00Z'), { feed: [tmd()] });
    assert.equal(r.code, 0, `${status}`);
    assert.deepEqual(gh.writes().slice(0, 4).map(callText), [
      `POST /repos/${REPO}/issues/101/comments`,
      `DELETE /repos/${REPO}/issues/101/lock`,
      `POST /repos/${REPO}/issues/101/comments`,
      `PUT /repos/${REPO}/issues/101/lock`,
    ], `${status}`);
    const board = gh.board('[health] feed')!;
    assert.equal(board.comments.length, 1, `${status}`);
    assert.equal(board.locked, true, `${status}`);
    assert.equal(parseBoardState(board.body, 'feed')!.entries['feed:source:tmd']!.notified, 'P3', `${status}`);
  }
  // GitHub accepts the comment on a locked board: no unlock at all.
  const ok = new FakeGitHub();
  await runMain(ok, T('2026-10-21T10:07:00Z'), {});
  ok.calls = [];
  await runMain(ok, T('2026-10-21T10:22:00Z'), { feed: [tmd()] });
  assert.equal(ok.calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(ok.board('[health] feed')!.comments.length, 1);
  // The relock fails: a warning (the run stays green), and the next run locks the board again.
  const gh = new FakeGitHub();
  gh.lockedRejectsComments = 403;
  await runMain(gh, T('2026-10-21T10:07:00Z'), {});
  gh.lockStatus = 500;
  const r = await runMain(gh, T('2026-10-21T10:22:00Z'), { feed: [tmd()] });
  assert.equal(r.code, 0);
  assert.equal(gh.board('[health] feed')!.comments.length, 1);
  assert.ok(r.lines.some((l) => l.startsWith('::warning title=Health reconcile::cannot lock board #101 again (unlocked to comment): HTTP 500')));
  assert.equal(gh.board('[health] feed')!.locked, false);
  gh.lockStatus = 204;
  const next = await runMain(gh, T('2026-10-21T10:37:00Z'), { feed: [tmd()] });
  assert.ok(next.lines.includes('re-locked board #101'));
  assert.equal(gh.board('[health] feed')!.locked, true);
});

test('main: a board locked against an edit of its body is unlocked, saved and locked again', async () => {
  for (const status of [403, 422] as const) {
    const gh = new FakeGitHub();
    await runMain(gh, T('2026-10-21T10:07:00Z'), {});
    gh.lockedRejectsPatch = status;
    gh.calls = [];
    const r = await runMain(gh, T('2026-10-21T10:22:00Z'), { feed: [tmd()] });
    assert.equal(r.code, 0, `${status}`);
    const feed = gh.writes().map(callText).filter((c) => c.includes('/issues/101'));
    assert.deepEqual(feed.slice(0, 5), [
      `POST /repos/${REPO}/issues/101/comments`,
      `PATCH /repos/${REPO}/issues/101`,
      `DELETE /repos/${REPO}/issues/101/lock`,
      `PATCH /repos/${REPO}/issues/101`,
      `PUT /repos/${REPO}/issues/101/lock`,
    ], `${status}`);
    assert.ok(r.lines.some((l) => l.startsWith('board #101 refused the write (save its body) while locked (HTTP')), `${status}`);
    const board = gh.board('[health] feed')!;
    assert.equal(board.locked, true, `${status}`);
    assert.equal(parseBoardState(board.body, 'feed')!.entries['feed:source:tmd']!.notified, 'P3', `${status}: saved`);
  }
});

test('main: labels GitHub dropped from a new board are set again; when that fails too the run exits 3 instead of creating boards on every run', async () => {
  const gh = new FakeGitHub();
  gh.dropLabelsOnCreate = true;
  assert.equal((await runMain(gh, T('2026-10-21T10:07:00Z'), {})).code, 0);
  assert.deepEqual(gh.issues.map((i) => i.labels.join(' ')), Array(3).fill('health-board health:ok'));
  await runMain(gh, T('2026-10-21T10:22:00Z'), {});
  assert.equal(gh.issues.length, 3, 'found again by their label: no duplicate');

  const bad = new FakeGitHub();
  bad.dropLabelsOnCreate = true;
  bad.labelsStatus = 500;
  const r = await runMain(bad, T('2026-10-21T10:07:00Z'), {});
  assert.equal(r.code, 3);
  assert.ok(r.lines.some((l) => l.startsWith('::error title=Health reconcile::cannot label the new board #100 health-board: HTTP 500')));
});

test('main: a board whose body cannot fit even shrunk is neither written nor commented on, so its comment never repeats; the run exits 3', async () => {
  const gh = new FakeGitHub();
  await runMain(gh, T('2026-10-21T10:07:00Z'), {});
  const sources = Array.from({ length: 150 }, (_, i) => f('feed:source', { id: `src${String(i).padStart(3, '0')}`, members: ['fetch'], sinceMs: T('2026-10-20T00:00:00Z'), text: `src${i} fetch failing for 34 h` }));
  for (const iso of ['2026-10-21T10:22:00Z', '2026-10-21T10:37:00Z']) {
    gh.calls = [];
    const r = await runMain(gh, T(iso), { feed: sources, alerts: [f('alerts:policy', { text: 'fallback policy' })] });
    assert.equal(r.code, 3, iso);
    assert.ok(r.lines.some((l) => /^::error title=Health reconcile::the body of "\[health\] feed" is \d+ characters even shrunk/.test(l)), iso);
    assert.deepEqual(gh.writes().map(callText).filter((c) => c.includes('/issues/101')), [], `${iso}: nothing written to the feed board`);
    assert.ok(gh.writes().some((c) => callText(c) === `PATCH /repos/${REPO}/issues/100`), `${iso}: the other boards are saved`);
  }
  assert.equal(gh.board('[health] feed')!.comments.length, 0);
});

test('main: once a day the boards\' pins and locks are checked through GraphQL and restored; a failure there is a warning only', async () => {
  const gh = new FakeGitHub();
  await runMain(gh, T('2026-10-21T10:07:00Z'), {});
  gh.issues[0]!.pinned = false;
  gh.calls = [];
  await runMain(gh, T('2026-10-21T10:22:00Z'), {});
  assert.equal(gh.calls.filter((c) => c.url.endsWith('/graphql')).length, 0, 'at most once a day');
  assert.equal(gh.issues[0]!.pinned, false);
  gh.calls = [];
  const day = await runMain(gh, T('2026-10-22T10:08:00Z'), {});
  const graphql = gh.calls.filter((c) => c.url.endsWith('/graphql')).map((c) => (c.body as { query: string; variables: unknown }));
  assert.equal(graphql.length, 2);
  assert.deepEqual(graphql[0]!.variables, { ids: gh.issues.map((i) => i.node_id) });
  assert.deepEqual(graphql[1]!.variables, { issueId: gh.issues[0]!.node_id });
  assert.equal(gh.issues[0]!.pinned, true);
  assert.ok(day.lines.includes('pinned board #100 again'));
  assert.equal(parseBoardState(gh.issues[1]!.body, 'feed')!.pinsCheckedMs, T('2026-10-22T10:08:00Z'));
  // GraphQL refused (GITHUB_TOKEN without the right): a warning, never red; checked again a day later.
  gh.graphqlStatus = 403;
  const refused = await runMain(gh, T('2026-10-23T10:08:00Z'), { alerts: [f('alerts:policy', { text: 'fallback policy' })] });
  assert.equal(refused.code, 1, 'the P1, nothing else');
  assert.ok(refused.lines.some((l) => l.startsWith("::warning title=Health reconcile::cannot check the boards' pins: HTTP 403")));
  const quiet = await runMain(gh, T('2026-10-23T10:22:00Z'), {});
  assert.equal(quiet.code, 0);
  assert.equal(parseBoardState(gh.issues[0]!.body, 'alerts')!.pinsCheckedMs, T('2026-10-23T10:08:00Z'));
});

test('main: pings are skipped without HC_PING_KEY; with it they are sent and the URL never reaches a log line', async () => {
  const gh = new FakeGitHub();
  const none = await runMain(gh, T('2026-10-21T10:07:00Z'), { alerts: [f('alerts:degraded', { text: 'ladder active' })] });
  assert.equal(none.code, 1);
  assert.equal(gh.calls.filter((c) => c.url.includes('hc-ping.com')).length, 0);
  assert.equal(none.lines.filter((l) => l === 'pings skipped (HC_PING_KEY unset)').length, 1);

  const key = 'k3y-SECRET';
  const sent = await runMain(gh, T('2026-10-21T10:22:00Z'), { alerts: [f('alerts:degraded', { text: 'ladder active' })] }, { env: { HC_PING_KEY: key } });
  const pings = gh.calls.filter((c) => c.url.startsWith(HC_PING_BASE));
  assert.deepEqual(pings.map((c) => c.url.slice(`${HC_PING_BASE}/${key}/`.length)), ['gh-detect/0', 'gh-deliver/fail', 'gh-redundancy/0', 'gh-feed/0', 'gh-platform/0', 'gh-capacity/0', 'gh-aging/0', 'health-watchdog/0']);
  assert.equal(pings[1]!.body, 'P1 alerts:degraded: ladder active');
  assert.ok(sent.lines.includes('pinged gh-deliver /fail'));
  for (const l of [...sent.lines, ...sent.summary]) {
    assert.ok(!l.includes(key), l);
    assert.ok(!l.includes('hc-ping.com'), l);
  }
  assert.match(gh.board('[health] alert pipeline')!.body, /Push transitions count the checks that went to \/fail\.\n/);

  gh.pingStatus = 503;
  gh.calls = [];
  const failed = await runMain(gh, T('2026-10-21T10:37:00Z'), {}, { env: { HC_PING_KEY: key } });
  assert.equal(failed.code, 0, 'a ping never changes the exit code');
  assert.equal(gh.calls.filter((c) => c.url.startsWith(HC_PING_BASE)).length, 8 * 3);
  const warnings = failed.lines.filter((l) => l.startsWith('::warning title=Health ping::'));
  assert.equal(warnings.length, 8);
  assert.equal(warnings[0], '::warning title=Health ping::gh-detect /0 failed after 3 tries: HTTP 503');
  for (const l of failed.lines) assert.ok(!l.includes(key) && !l.includes('hc-ping.com'), l);
});

test('main: an unreadable findings file or no directory marks evaluators missing; --dry-run writes nothing', async () => {
  const gh = new FakeGitHub();
  const now = T('2026-10-21T10:07:00Z');
  const lines: string[] = [];
  const dir = findingsDir(docsAt(now, { feed: null }), { 'feed.json': '{"schema":' });
  await main({ argv: ['--findings-dir', 'findings'], env: ENV, fetchImpl: gh.fetchImpl, now: () => now, sleep: async () => {}, log: (l) => lines.push(l), appendFile: () => {}, ...dir });
  const state = parseBoardState(gh.board('[health] platform')!.body, 'platform')!;
  assert.match(state.entries['watcher:evaluator:feed']!.text, /feed\.json is unreadable: /);

  const none = new FakeGitHub();
  await main({ argv: ['--findings-dir', 'nowhere'], env: ENV, fetchImpl: none.fetchImpl, now: () => now, sleep: async () => {}, log: () => {}, appendFile: () => {}, ...findingsDir([]) });
  const st = parseBoardState(none.board('[health] platform')!.body, 'platform')!;
  assert.deepEqual(Object.keys(st.entries), ['watcher:evaluator:alerts', 'watcher:evaluator:feed', 'watcher:evaluator:platform']);

  const dry = new FakeGitHub();
  const out = await runMain(dry, now, { feed: [tmd()] }, { argv: ['--findings-dir', 'findings', '--dry-run'], env: { HC_PING_KEY: 'k' } });
  assert.equal(out.code, 0);
  assert.deepEqual(dry.writes(), []);
  assert.equal(dry.calls.filter((c) => c.url.startsWith(HC_PING_BASE)).length, 0);
  assert.ok(out.lines.some((l) => l.startsWith('----- new board "[health] feed"')));
  assert.ok(out.lines.some((l) => l.startsWith('----- comment on "[health] feed" -----')));
  // Without a token a dry run starts from empty boards; a real run treats it as unreadable boards.
  const local = await runMain(new FakeGitHub(), now, { feed: [tmd()] }, { argv: ['--findings-dir', 'findings', '--dry-run'], env: { GH_TOKEN: '' } });
  assert.equal(local.code, 0);
  const real = await runMain(new FakeGitHub(), now, { alerts: [f('alerts:policy', { text: 'fallback' })] }, { env: { GH_TOKEN: '' } });
  assert.equal(real.code, 3);
  assert.equal(await main({ argv: ['--bogus'], env: ENV, log: () => {} }), 3);
});

test('main --gate: writes run= and selftest= to GITHUB_OUTPUT; skips the fallback cron after a dispatched run; any API error runs', async () => {
  const now = T('2026-10-21T15:22:39Z');
  const gate = async (gh: FakeGitHub, env: Record<string, string>): Promise<{ code: number; out: string[]; summary: string[] }> => {
    const out: string[] = [];
    const summary: string[] = [];
    const code = await main({
      argv: ['--gate'],
      env: { GH_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: '/out', GITHUB_STEP_SUMMARY: '/sum', ...env },
      fetchImpl: gh.fetchImpl,
      now: () => now,
      sleep: async () => {},
      log: () => {},
      appendFile: (p, s) => (p === '/out' ? out : summary).push(s),
    });
    return { code, out, summary };
  };
  const gh = new FakeGitHub();
  gh.dispatched = [{ created_at: '2026-10-21T15:22:30Z', status: 'in_progress', conclusion: null }];
  const skip = await gate(gh, { EVENT: 'schedule', SCHEDULE: HEALTH_FALLBACK_CRON });
  assert.deepEqual(skip, { code: 0, out: ['run=false\nselftest=0\n'], summary: [skip.summary[0]!] });
  assert.match(skip.summary[0]!, /Skipped: a workflow_dispatch health run was created 9 s ago/);
  gh.dispatched = [{ created_at: '2026-10-21T15:22:30Z', status: 'completed', conclusion: 'cancelled' }];
  assert.deepEqual((await gate(gh, { EVENT: 'schedule', SCHEDULE: HEALTH_FALLBACK_CRON })).out, ['run=true\nselftest=0\n'], 'a cancelled run does not count');
  gh.runsStatus = 500;
  assert.deepEqual((await gate(gh, { EVENT: 'schedule', SCHEDULE: HEALTH_FALLBACK_CRON })).out, ['run=true\nselftest=0\n']);
  const calls = gh.calls.length;
  assert.deepEqual((await gate(gh, { EVENT: 'workflow_dispatch', SELFTEST_INPUT: 'true' })).out, ['run=true\nselftest=1\n']);
  assert.equal(gh.calls.length, calls, 'no API call for a dispatched run');
  assert.deepEqual((await gate(gh, { EVENT: 'schedule', SCHEDULE: SELFTEST_CRON })).out, ['run=true\nselftest=1\n']);
});

test('the P2 red hour is measured from when the entry first became P2, across a frozen stretch', () => {
  const w = new World();
  const api = f('platform:api', { text: 'api.theshelter.app/v1/health is DOWN: HTTP 522 after 3 attempt(s)' });
  assert.equal(w.run('2026-10-21T10:07:00Z', { platform: [api] }).exitCode, 1);
  assert.equal(w.run('2026-10-21T10:22:00Z', { platform: null }).exitCode, 1, 'frozen, still within the hour');
  assert.equal(w.run('2026-10-21T11:07:00Z', { platform: null }).exitCode, 0, 'frozen, past the hour');
  assert.equal(w.entry('platform:api')!.open, true);
  assert.equal(w.entry('platform:api')!.redSinceMs, T('2026-10-21T10:07:00Z'));
});

test('time escalation counts from the episode start: a TMD certificate failure since 02:01 escalates 24 h later', () => {
  const w = new World();
  const since = T('2026-10-09T02:01:00Z');
  const r = w.run('2026-10-09T04:07:00Z', { feed: [tmd('P3', since)] });
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0]!.body, /since 2026-10-09 02:01Z, 2\.1 h\)/);
  assert.equal(w.run('2026-10-10T01:52:00Z', { feed: [tmd('P3', since)] }).comments.length, 0);
  const esc = w.run('2026-10-10T02:07:00Z', { feed: [tmd('P3', since)] });
  assert.equal(esc.comments.length, 1);
  assert.match(esc.comments[0]!.body, /— open for 24\.1 h: /);
  assert.deepEqual(signal(esc, 'gh-aging'), ['fail']);
  assert.equal(esc.exitCode, 0);
  assert.equal(w.run('2026-10-10T02:22:00Z', { feed: [tmd('P3', since)] }).comments.length, 0, 'escalates once');
});

test('the copies on every board: the last applied document is the max per evaluator; the checks come from the newest board', () => {
  const now = T('2026-10-21T10:07:00Z');
  const base = (board: Board, updatedMs: number, evaluators: BoardState['evaluators'], checks: BoardState['checks']): BoardState => ({
    v: 1,
    board,
    createdMs: updatedMs - 2 * HOUR,
    updatedMs,
    runId: '1',
    runUrl: null,
    pings: 'skipped',
    evaluators,
    checks,
    lastSelftestMs: null,
    pinsCheckedMs: updatedMs - HOUR,
    faults: [],
    entries: {},
    log: [],
    days: {},
  });
  const prev = {
    alerts: base('alerts', now - 30 * MIN, { alerts: now - 40 * MIN }, { 'gh-deliver': 'success' }),
    feed: base('feed', now - 15 * MIN, { alerts: now - 20 * MIN, feed: now - 20 * MIN }, { 'gh-deliver': 'fail' }),
    platform: null,
  };
  const docs = new World().docs(now, {}, { generatedAtMs: now - 25 * MIN });
  const r = reconcile(prev, docs, now, [], { eventName: 'workflow_dispatch' });
  assert.equal(r.evaluators.alerts.state, 'stale', 'older than the max (the feed board copy)');
  assert.equal(r.evaluators.feed.state, 'stale');
  assert.equal(r.evaluators.platform.state, 'fresh');
  assert.equal(r.replay, false);
  assert.equal(r.state.feed!.days[isoDay(now)]?.transitions ?? 0, 0, 'gh-deliver was already failing on the newest board; now success');
  assert.deepEqual(Object.keys(r.state.feed!.evaluators), ['alerts', 'feed', 'platform'], 'in evaluator order');
  assert.equal(r.state.feed!.evaluators.platform, now - 25 * MIN);
  assert.equal(r.state.alerts!.checks['gh-deliver'], 'success');
});

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
