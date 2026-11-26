import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { eventDayKey, loadEventMap, pruneEventMapShards, saveEventMap } from '../src/bitemporal.js';
import { windowDays } from '../src/backfill-plan.js';
import { EVENT_MAP_HORIZON_DAYS, dataPaths } from '../src/config.js';
import {
  EVENT_MAP_FILE,
  IGNORE_LINES,
  SENTINEL_FILE,
  SENTINEL_FILES,
  SENTINEL_TEXT,
  eventMapFiles,
  liveFloorOf,
  main,
  pruneGeneration,
  readCanonicalDay,
  readGeneration,
  trackedEventMapPaths,
} from '../src/event-map-store.js';
import { stageData } from '../src/stage-data.js';
import { sha256Hex } from '../src/state-store.js';
import type { EventNode } from '../src/types.js';

// Storage phase 3b on real git repositories (a bare `origin` holding `data`, clones as the jobs check it out, a
// directory state store): the transition run that untracks phase 3a's hour shards, the runs after it, a push retry's
// rebase over a lockless commit (before and after the transition), derive's midnight prune with day files, the
// rollback's re-track, and what code from before phase 3b does with the branch (the sentinels' purpose). The commit
// step runs as aggregate.yml runs it: `stage`, `git add knowledge status status.json .gitignore`, `assert-staged`.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUSH = join(ROOT, 'scripts/push-data.sh');
const DAY_MS = 86_400_000;
const NOW = Date.now();
/** Four event-days inside the 45-day horizon of today's clock (persist's cutoff reads the real clock). */
const DAYS = [3, 2, 1, 0].map((d) => eventDayKey(NOW - d * DAY_MS));

function node(feedId: string, eventTimeMs: number, lastSeq = 1, place = 'x'): EventNode {
  const iso = new Date(eventTimeMs).toISOString();
  return {
    feedId,
    aliases: [`usgs:${feedId}`],
    eventTimeMs,
    firstIngestTime: iso,
    lastIngestTime: iso,
    lat: 1,
    lon: 2,
    depth: 10,
    mag: 4.5,
    magType: 'mb',
    status: null,
    place,
    chosenProvider: 'usgs',
    provenance: [],
    revision: 1,
    firstSeenSeq: 1,
    lastSeq,
    state: 'live',
    geohash: 'g',
  };
}
const at = (day: string, hh: number): number => Date.parse(`${day}T${String(hh).padStart(2, '0')}:20:00Z`);

/** git with a private HOME (no user config, no signing) and a fixed identity. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'phase3b-'));
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_AUTHOR_NAME: 'earthquakes-feed-bot',
    GIT_AUTHOR_EMAIL: 'bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'earthquakes-feed-bot',
    GIT_COMMITTER_EMAIL: 'bot@users.noreply.github.com',
  };
  writeFileSync(join(dir, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = data\n');
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const store = join(dir, 'store');
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', origin);
  let n = 0;
  const clone = (): string => {
    const c = join(dir, `c${n++}`);
    git(dir, 'clone', '-q', '--depth', '1', '--branch', 'data', `file://${origin}`, c);
    return c;
  };
  /** One src/event-map-store.ts command on a checkout, as the workflows run it (exit code, marker of the step). */
  const step = async (root: string, ...argv: string[]): Promise<{ code: number; marker: Record<string, unknown> | null }> => {
    const markers = join(dir, `markers-${n++}`);
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const code = await main(argv, { ...e, DATA_DIR: root, FEED_STATE_BACKEND: `fs:${store}`, FEED_STATE_MARKER_DIR: markers });
      const f = join(markers, `${argv[0]}.json`);
      return { code, marker: existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>) : null };
    } finally {
      console.log = log;
      console.error = err;
    }
  };
  /** aggregate.yml's commit step: the transition and the layout move, the add, the check, the commit. */
  const commitStep = async (root: string, msg: string): Promise<void> => {
    assert.equal((await step(root, 'stage')).code, 0);
    git(root, 'add', '--', ...['knowledge', 'status', 'status.json', '.gitignore'].filter((p) => existsSync(join(root, p))));
    assert.equal((await step(root, 'assert-staged')).code, 0);
    git(root, 'commit', '-q', '-m', msg);
  };
  const push = (root: string) => spawnSync('bash', [PUSH], { cwd: root, env: { ...e, PUSH_ATTEMPTS: '3', PUSH_BACKOFF_S: '0' }, encoding: 'utf8' });
  const setSeq = (root: string, seq: number): void => writeFileSync(dataPaths(root).head, JSON.stringify({ seq, ingest_time: new Date(NOW).toISOString() }) + '\n');
  /** A lockless side-index commit (first-solutions' commit job) pushed by a clone of its own. */
  const sideCommit = (label: string): void => {
    const c = clone();
    mkdirSync(join(c, 'knowledge/first_solutions'), { recursive: true });
    writeFileSync(join(c, 'knowledge/first_solutions/cursor.json'), `{"label":"${label}"}\n`);
    git(c, 'add', 'knowledge/first_solutions');
    git(c, 'commit', '-q', '-m', `first-solutions: ${label}`);
    git(c, 'push', '-q', 'origin', 'HEAD:data');
  };
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  return { dir, e, git, store, origin, clone, step, commitStep, push, setSeq, sideCommit, cleanup };
}
type World = ReturnType<typeof world>;

const NODES = (): EventNode[] => [
  node('efd_a', at(DAYS[0]!, 1)),
  node('efd_b', at(DAYS[1]!, 2)),
  node('efd_c', at(DAYS[1]!, 13)),
  node('efd_d', at(DAYS[2]!, 23)),
];

/** `data` as phase 3a leaves it: hour shards tracked, the generation persisted beside them (git the truth). */
async function phase3aBranch(w: World): Promise<string> {
  const seed = join(w.dir, 'seed');
  mkdirSync(dataPaths(seed).indexDir, { recursive: true });
  w.git(w.dir, 'init', '-q', seed);
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n.data/\npublic/\n.DS_Store\n');
  writeFileSync(join(seed, 'status.json'), '{"seq":10}\n');
  w.setSeq(seed, 10);
  saveEventMap(seed, new Map(NODES().map((x) => [x.feedId, x])), { hours: 1 });
  assert.equal((await w.step(seed, 'persist')).code, 0);
  w.git(seed, 'add', '-A');
  w.git(seed, 'commit', '-q', '-m', 'aggregate: seq=10 (phase 3a)');
  w.git(seed, 'push', '-q', w.origin, 'HEAD:data');
  return seed;
}

const shards = (root: string): string[] => readdirSync(dataPaths(root).eventMapDir).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{2}\.ndjson$/.test(f)).sort();
const dayFiles = (root: string): string[] => readdirSync(dataPaths(root).eventMapDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f) && !SENTINEL_FILES.includes(f as never)).sort();
/** Every generation day on disk, byte for byte its entry (what the next hydrate keeps without a fetch), and no other. */
function matchesGeneration(root: string): boolean {
  const g = readGeneration(root)!.generation;
  const files = eventMapFiles(root);
  return (
    Object.keys(g.days).length === files.size &&
    Object.entries(g.days).every(([d, e]) => files.has(d) && sha256Hex(readCanonicalDay(root, files.get(d)!).text) === e.sha256)
  );
}

test('the transition run: the hydrate keeps git\'s checkout, the commit untracks every hour shard and adds the sentinels and the ignore lines, the layout moves after the untrack', async () => {
  const w = world();
  try {
    await phase3aBranch(w);
    const a = w.clone();
    const tracked = trackedEventMapPaths(a);
    assert.equal(tracked.length, 4, 'phase 3a: four hour shards tracked');
    // State hydrate: git still tracks the map, so the checkout is the truth for this run: kept, nothing fetched.
    const h = await w.step(a, 'hydrate');
    assert.equal(h.code, 0);
    assert.equal(h.marker!.ok, true);
    assert.match(String(h.marker!.summary), /^git still tracks 4 event-map file\(s\) in the checkout .*every one identical to the checkout/);
    assert.deepEqual(shards(a), tracked.map((p) => p.slice(p.lastIndexOf('/') + 1)));
    // Aggregate: one revision, one new event on a new day. saveEventMap still writes hour shards (git tracks them).
    const m = loadEventMap(a);
    m.get('efd_b')!.place = 'revised';
    m.get('efd_b')!.lastSeq = 11;
    m.set('efd_e', node('efd_e', at(DAYS[3]!, 4), 11));
    saveEventMap(a, m);
    w.setSeq(a, 11);
    assert.deepEqual(dayFiles(a), [], 'no layout change before the untrack');
    assert.equal(shards(a).length, 5);
    // The store lost the blob of a day that did not change (DAYS[0]): only git's shard holds it now. The transition's
    // persist uploads every day while git tracks them, so the commit that untracks the shards never leaves a lost blob
    // as the only copy.
    const blob0 = readGeneration(a)!.generation.days[DAYS[0]!]!.blob;
    const blob0File = join(w.store, 'cas', 'sha256', blob0.slice(0, 2), blob0);
    rmSync(blob0File);
    // State persist: every day uploaded (the changed, the new and the unchanged ones), the generation rewritten.
    const p = await w.step(a, 'persist');
    assert.equal(p.code, 0);
    assert.match(String(p.marker!.summary), /^git still tracks 4 event-map file\(s\): every day uploaded, unchanged ones included .*; 4 day\(s\); 4 uploaded/);
    assert.equal(readGeneration(a)!.generation.days[DAYS[0]!]!.blob, blob0);
    assert.ok(existsSync(blob0File), 'the lost blob is back before the commit untracks the shards');
    // A lockless commit lands first: the push retry rebases the transition commit over it.
    w.sideCommit('before the transition');
    await w.commitStep(a, 'aggregate: seq=11');
    // The transition commit's exact content.
    const content = w.git(a, 'show', '--name-status', '--no-renames', '--format=', 'HEAD').trim().split('\n').sort();
    assert.deepEqual(content, [
      'A\tknowledge/index/event_map/0000-00-00.ndjson',
      'A\tknowledge/index/event_map/9999-12-31.ndjson',
      ...tracked.map((p) => `D\t${p}`),
      'M\t.gitignore',
      'M\tknowledge/index/generation.json',
      'M\tknowledge/index/head.json',
    ].sort());
    assert.equal(w.git(a, 'show', 'HEAD:.gitignore'), `node_modules/\n.data/\npublic/\n.DS_Store\n${IGNORE_LINES.join('\n')}\n`);
    for (const f of SENTINEL_FILES) assert.equal(w.git(a, 'show', `HEAD:knowledge/index/event_map/${f}`), SENTINEL_TEXT);
    // On disk: the layout moved (after the untrack): one day file a day, ignored, no hour shard.
    assert.deepEqual([shards(a), dayFiles(a)], [[], DAYS.map((d) => `${d}.ndjson`)]);
    assert.equal(w.git(a, 'status', '--porcelain'), '');
    const pushed = w.push(a);
    assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
    assert.deepEqual(w.git(a, 'log', '--format=%s', 'origin/data').trim().split('\n'), ['aggregate: seq=11', 'first-solutions: before the transition', 'aggregate: seq=10 (phase 3a)']);
    // The rebase checked out the parent (which tracks the shards) and replayed the deletion: the day files survived,
    // so derive-publish's re-hydrate fetches nothing.
    assert.deepEqual([shards(a), dayFiles(a)], [[], DAYS.map((d) => `${d}.ndjson`)]);
    assert.ok(matchesGeneration(a));
    const re = await w.step(a, 'hydrate');
    assert.equal(re.code, 0);
    assert.match(String(re.marker!.summary), /^4 day\(s\) written, 0 fetched/);
    // The branch now: the sentinels, the generation; a fresh checkout reads nothing until it is hydrated.
    const b = w.clone();
    assert.deepEqual(readdirSync(dataPaths(b).eventMapDir).sort(), [...SENTINEL_FILES]);
    assert.deepEqual(trackedEventMapPaths(b), []);
    assert.throws(() => loadEventMap(b), /lists 4 day\(s\) the checkout lacks .*holds no event-map day at all: since storage phase 3b/);
    const hb = await w.step(b, 'hydrate');
    assert.equal(hb.code, 0);
    assert.match(String(hb.marker!.summary), /^4 day\(s\) written, 4 fetched/);
    for (const d of DAYS) assert.equal(readFileSync(join(dataPaths(b).eventMapDir, `${d}.ndjson`), 'utf8'), readFileSync(join(dataPaths(a).eventMapDir, `${d}.ndjson`), 'utf8'));
    assert.match(JSON.stringify([...loadEventMap(b).values()].find((x) => x.feedId === 'efd_b')), /"place":"revised"/);
    // The next run's commit step stages nothing of the event map: only the sentinels stay tracked.
    w.setSeq(b, 12);
    await w.commitStep(b, 'aggregate: seq=12');
    assert.deepEqual(w.git(b, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n'), ['M\tknowledge/index/head.json']);
  } finally {
    w.cleanup();
  }
});

/** A branch after the transition, pushed, with its store. */
async function phase3bBranch(w: World): Promise<void> {
  await phase3aBranch(w);
  const a = w.clone();
  assert.equal((await w.step(a, 'hydrate')).code, 0);
  w.setSeq(a, 11);
  assert.equal((await w.step(a, 'persist')).code, 0);
  await w.commitStep(a, 'aggregate: seq=11 (the transition)');
  assert.equal(w.push(a).status, 0);
}

test('after the transition: a run rebased over a lockless commit keeps its day files; the pushed tree holds no event-map path but the sentinels', async () => {
  const w = world();
  try {
    await phase3bBranch(w);
    const b = w.clone();
    assert.equal((await w.step(b, 'hydrate')).code, 0);
    const m = loadEventMap(b);
    m.get('efd_d')!.place = 'revised after 3b';
    m.get('efd_d')!.lastSeq = 12;
    saveEventMap(b, m);
    assert.deepEqual(shards(b), [], 'git tracks no event-map file: day files');
    w.setSeq(b, 12);
    assert.equal((await w.step(b, 'persist')).code, 0);
    await w.commitStep(b, 'aggregate: seq=12');
    w.sideCommit('after the transition');
    const r = w.push(b);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(w.git(b, 'log', '--format=%s', '-2', 'origin/data').trim().split('\n'), ['aggregate: seq=12', 'first-solutions: after the transition']);
    assert.deepEqual(w.git(b, 'ls-tree', '-r', '--name-only', 'origin/data', '--', 'knowledge/index/event_map').trim().split('\n'), SENTINEL_FILES.map((f) => `knowledge/index/event_map/${f}`));
    assert.equal(w.git(b, 'status', '--porcelain'), '');
    assert.ok(matchesGeneration(b), 'the ignored day files are untouched by the rebase');
    // And the next run, from a fresh checkout, reads the revision from the store.
    const c = w.clone();
    assert.equal((await w.step(c, 'hydrate')).code, 0);
    assert.equal(loadEventMap(c).get('efd_d')!.place, 'revised after 3b');
  } finally {
    w.cleanup();
  }
});

test('derive\'s midnight prune with day files: the day leaves the disk and the generation; the commit carries the generation only; the next hydrate and persist agree', async () => {
  const w = world();
  try {
    await phase3bBranch(w);
    const d = w.clone();
    assert.equal((await w.step(d, 'hydrate')).code, 0);
    // derive just after the midnight that puts DAYS[0] below the horizon (its clock: the day after it + 45 days).
    const midnight = Date.parse(`${DAYS[1]}T00:00:30Z`) + EVENT_MAP_HORIZON_DAYS * DAY_MS;
    const before = midnight - EVENT_MAP_HORIZON_DAYS * DAY_MS;
    assert.deepEqual(pruneEventMapShards(d, before), [DAYS[0]]);
    assert.deepEqual(pruneGeneration(d, eventDayKey(before)), [DAYS[0]]);
    assert.deepEqual(dayFiles(d), DAYS.slice(1, 3).map((x) => `${x}.ndjson`));
    for (const f of SENTINEL_FILES) assert.ok(existsSync(join(dataPaths(d).eventMapDir, f)), `${f}: never pruned`);
    const staged = stageData(d, ['.'], midnight, (args) => w.git(d, ...args));
    assert.deepEqual(staged.keptOut, []);
    assert.deepEqual(w.git(d, 'diff', '--cached', '--name-status').trim().split('\n'), ['M\tknowledge/index/generation.json']);
    w.git(d, 'commit', '-q', '-m', 'derive: views');
    assert.equal(w.push(d).status, 0);
    // The next aggregate: its hydrate writes exactly the generation's days, its persist has nothing to say about the
    // pruned one (it is gone from the generation, not missing from the checkout).
    const e = w.clone();
    const h = await w.step(e, 'hydrate');
    assert.equal(h.code, 0);
    assert.deepEqual(dayFiles(e), DAYS.slice(1, 3).map((x) => `${x}.ndjson`));
    const p = await w.step(e, 'persist');
    assert.equal(p.code, 0);
    assert.match(String(p.marker!.summary), /^2 day\(s\); nothing uploaded; generation unchanged/);
  } finally {
    w.cleanup();
  }
});

test('the rollback\'s re-track (derive.yml retrack): the hydrated map back in git as hour shards, sentinels and ignore lines gone; refused unhydrated; the next 3b run makes the transition again', async () => {
  const w = world();
  try {
    await phase3bBranch(w);
    const r = w.clone();
    // Not hydrated: refused, nothing staged.
    assert.equal(await (async () => { try { await w.step(r, 'retrack'); return 'ran'; } catch (err) { return String(err); } })().then((x) => /hydrate first/.test(x)), true);
    assert.equal(w.git(r, 'diff', '--cached', '--name-only'), '');
    assert.equal((await w.step(r, 'hydrate')).code, 0);
    assert.equal((await w.step(r, 'retrack')).code, 0);
    const staged = w.git(r, 'diff', '--cached', '--name-status').trim().split('\n').sort();
    assert.deepEqual(staged, [
      ...SENTINEL_FILES.map((f) => `D\tknowledge/index/event_map/${f}`),
      'M\t.gitignore',
      ...shards(r).map((f) => `A\tknowledge/index/event_map/${f}`),
    ].sort());
    assert.equal(shards(r).length, 4);
    assert.doesNotMatch(readFileSync(join(r, '.gitignore'), 'utf8'), /event_map/);
    w.git(r, 'commit', '-q', '-m', 'retrack');
    assert.equal(w.push(r).status, 0);
    // Phase 3a's view of the branch: hour shards tracked, the generation byte for byte their canonical days.
    const back = w.clone();
    assert.equal(trackedEventMapPaths(back).length, 4);
    assert.ok(matchesGeneration(back));
    assert.deepEqual([...loadEventMap(back).keys()].sort(), ['efd_a', 'efd_b', 'efd_c', 'efd_d']);
    // A phase-3b run on it (the revert not merged yet, aggregate.yml not disabled): git is the truth again, and its
    // commit makes the transition once more, losing nothing.
    const h = await w.step(back, 'hydrate');
    assert.match(String(h.marker!.summary), /^git still tracks 4 event-map file/);
    w.setSeq(back, 13);
    assert.equal((await w.step(back, 'persist')).code, 0);
    await w.commitStep(back, 'aggregate: seq=13');
    assert.equal(w.git(back, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'knowledge/index/event_map').trim(), SENTINEL_FILES.map((f) => `knowledge/index/event_map/${f}`).join('\n'));
    assert.ok(matchesGeneration(back));
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Code from before phase 3b on a phase-3b branch: the sentinels make it fail closed. The runbook forbids re-running a
// run from before the merge and drains the writer queue first; these are the backstop.

/** The loader of the code before phase 3 (src/bitemporal.ts loadEventMap at 024b68ec16b^, its loop copied): every
 *  `*.ndjson` whose first 10 characters are not below the cutoff day is parsed, line by line. */
function loadEventMapBeforePhase3(dir: string, opts: { sinceDays?: number; nowMs: number }): Map<string, EventNode> {
  const cutoffDay = opts.sinceDays != null ? eventDayKey(opts.nowMs - opts.sinceDays * DAY_MS) : null;
  const map = new Map<string, EventNode>();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.ndjson')) continue;
    if (cutoffDay && f.slice(0, 10) < cutoffDay) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const t = line.trim();
      if (t) {
        const n = JSON.parse(t) as EventNode;
        map.set(n.feedId, n);
      }
    }
  }
  return map;
}

/** backfill's floor before phase 3 (src/backfill.ts earliestLiveDay at 024b68ec16b^): the smallest name, else today. */
function earliestLiveDayBeforePhase3(dir: string, nowMs: number): string {
  if (!existsSync(dir)) return eventDayKey(nowMs);
  return readdirSync(dir).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, 10)).sort()[0] ?? eventDayKey(nowMs);
}

/** The loader of phase 3a (the code on main before this merge): it skips `0000-00-00*` only, so the high sentinel is
 *  an event-day to it, and it throws on a generation day the checkout lacks before it reads anything. */
function loadEventMapPhase3a(root: string): number {
  const g = readGeneration(root)!.generation;
  const dir = dataPaths(root).eventMapDir;
  const names = readdirSync(dir).filter((f) => EVENT_MAP_FILE.test(f) && !f.startsWith('0000-00-00'));
  const lacking = Object.keys(g.days).filter((d) => !names.some((f) => f.startsWith(d)));
  if (lacking.length) throw new Error(`event map: the generation lists ${lacking.length} day(s) the checkout lacks`);
  let n = 0;
  for (const f of names) for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) if (l.trim()) n += JSON.parse(l) ? 1 : 0;
  return n;
}

test('code from before phase 3b on the phase-3b branch fails closed: the old loader throws on the high sentinel with or without a cutoff, the old floor is 0000-00-00 (an old backfill fills nothing), phase 3a throws on the lacking days', async () => {
  const w = world();
  try {
    await phase3bBranch(w);
    const c = w.clone();
    const dir = dataPaths(c).eventMapDir;
    // aggregate (LIVE_INDEX_DAYS) and derive (45 days) load with a cutoff; tools load without one: both throw.
    for (const sinceDays of [3, EVENT_MAP_HORIZON_DAYS, undefined]) {
      assert.throws(() => loadEventMapBeforePhase3(dir, { sinceDays, nowMs: NOW }), SyntaxError, `sinceDays ${sinceDays}`);
    }
    // Why two sentinels: with only 0000-00-00, below every cutoff, the old aggregate and derive read an EMPTY map
    // (every event minted anew, empty views published), instead of throwing.
    rmSync(join(dir, SENTINEL_FILES[1]));
    assert.equal(loadEventMapBeforePhase3(dir, { sinceDays: EVENT_MAP_HORIZON_DAYS, nowMs: NOW }).size, 0, 'the gap the high sentinel closes');
    assert.throws(() => loadEventMapBeforePhase3(dir, { nowMs: NOW }), SyntaxError);
    w.git(c, 'checkout', '--', '.');
    // The old backfill's floor: the smallest name, 0000-00-00 (git's tree holds both sentinels); it fills only days
    // strictly before it, so its plan has no day at all. Only the high sentinel would have made the floor 9999-12-31.
    assert.equal(earliestLiveDayBeforePhase3(dir, NOW), SENTINEL_FILE.slice(0, 10));
    const jobs = [{ startMs: NOW - 400 * DAY_MS, endMs: NOW }];
    assert.deepEqual(windowDays(jobs, earliestLiveDayBeforePhase3(dir, NOW)), []);
    assert.notDeepEqual(windowDays(jobs, '9999-12-31'), [], 'a high floor would let it write live-owned days');
    // Phase 3a's loader: the generation's days are lacking (and the high sentinel would not parse either).
    assert.throws(() => loadEventMapPhase3a(c), /lists 3 day\(s\) the checkout lacks/);
    // This code: the same refusal, and the floor from the generation.
    assert.throws(() => loadEventMap(c), /lists 3 day\(s\) the checkout lacks/);
    assert.deepEqual(liveFloorOf(c, NOW, {}), { day: DAYS[0], source: 'generation' });
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The workflows' order and fail-closed wiring.

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
/** The text of a step by its name (up to the next step). */
function stepOf(yml: string, name: string): string {
  const i = yml.indexOf(`- name: ${name}\n`);
  assert.ok(i >= 0, name);
  const next = yml.slice(i + 1).search(/\n {4,6}- (name|uses|run): /);
  return yml.slice(i, next < 0 ? undefined : i + 1 + next);
}

test('wiring: every reader of the event map hydrates first, fail closed; the snapshot reads the hydrated checkout; persist stops the run before its push', () => {
  const agg = read('.github/workflows/aggregate.yml');
  const order = ['State hydrate', 'Snapshot the silent-change baseline', 'Aggregate', 'State persist', 'Upload the state report', 'Commit & push observation log', 'Derive and publish'];
  const at = order.map((n) => agg.indexOf(`- name: ${n}\n`));
  assert.ok(at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1]!)), `aggregate.yml order: ${order.join(' → ')}`);
  for (const [name, minutes] of [['State hydrate', 3], ['State persist', 4]] as const) {
    const s = stepOf(agg, name);
    assert.doesNotMatch(s, /\n {8}continue-on-error:/, `aggregate.yml ${name}: fail closed`);
    assert.match(s, new RegExp(`\\n {8}timeout-minutes: ${minutes}\\n`), `aggregate.yml ${name}: ${minutes} min`);
    assert.match(s, /\n {10}FEED_STATE_BACKEND: worker\n/);
    assert.match(s, /\n {10}FEED_STATE_MARKER_DIR: \$\{\{ runner\.temp \}\}\/state-shadow\n/);
  }
  assert.match(stepOf(agg, 'State hydrate'), /\n {8}run: npx --no-install tsx src\/event-map-store\.ts hydrate$/);
  assert.match(stepOf(agg, 'Upload the state report'), /\n {8}if: always\(\)\n/, 'the markers of a failed run are uploaded too');
  const derive = read('.github/workflows/derive.yml');
  const dh = stepOf(derive, 'State hydrate');
  assert.doesNotMatch(dh, /\n {8}continue-on-error:/);
  assert.match(dh, /\n {8}timeout-minutes: 3\n/);
  assert.ok(derive.indexOf('- name: State hydrate\n') < derive.indexOf('- name: Re-track the event map (rollback only)\n'));
  assert.ok(derive.indexOf('- name: Re-track the event map (rollback only)\n') < derive.indexOf('- name: Snapshot the silent-change baseline\n'));
  assert.ok(derive.indexOf('- name: Snapshot the silent-change baseline\n') < derive.indexOf('- name: Derive and publish\n'));
  const action = read('.github/actions/derive-publish/action.yml');
  assert.ok(action.indexOf('- name: Start from the data commit\n') < action.indexOf('- name: State hydrate (after the reset)\n'));
  assert.ok(action.indexOf('- name: State hydrate (after the reset)\n') < action.indexOf('- name: Derive views\n'));
  const fs = read('.github/workflows/first-solutions.yml');
  const fh = stepOf(fs, 'State hydrate');
  assert.doesNotMatch(fh, /\n {8}continue-on-error:/);
  assert.match(fh, /\n {8}timeout-minutes: 3\n/);
  assert.ok(fs.indexOf('- name: State hydrate\n') < fs.indexOf('- name: Collect\n'));
  // No step is phase-3b-only any more, and no workflow or action runs a shadow hydrate.
  for (const f of ['.github/workflows/aggregate.yml', '.github/workflows/derive.yml', '.github/workflows/first-solutions.yml', '.github/actions/derive-publish/action.yml']) {
    assert.doesNotMatch(read(f), /--3b-only|--mode shadow|State shadow hydrate/, f);
  }
});
