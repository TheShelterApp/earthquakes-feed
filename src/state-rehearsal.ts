import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveEventMap } from './bitemporal.js';
import { dataPaths } from './config.js';
import { dayFileName, eventMapFiles, hydrate, persist, readCanonicalDay, readGeneration } from './event-map-store.js';
import { collect, gcCounts, GC_MIN_AGE_DAYS } from './state-gc.js';
import { backupMembers, compressBackup, decompressBackup, readTar, verifyBackup, writeTar } from './state-backup.js';
import { gzipSync } from 'node:zlib';
import {
  RefConflict,
  StateStoreError,
  WorkerBackend,
  backendFromEnv,
  budgetLine,
  canonicalJson,
  casKey,
  getBlobs,
  nextRef,
  reflogAll,
  sha256Hex,
  swapRef,
  writerFromEnv,
  type RefRead,
  type RefSwap,
  type StateBackend,
  type StateRef,
} from './state-store.js';
import type { EventNode } from './types.js';

/**
 * The state store's rehearsal (state-rehearsal.yml, dispatched by hand from any branch; storage phase 3). It runs the
 * client's whole path against the STAGING Worker and bucket (feed-state-staging.theshelter.app, audience
 * earthquakes-feed-state-staging, which admits any branch of this repository) on synthetic data only: staging never
 * reads production's state. A temporary data root with a synthetic event map of REHEARSAL_DAYS days (feed ids unique
 * to the run, so every blob is new) is persisted, shadow-hydrated (no mismatch), changed and persisted again (one
 * upload), hydrated authoritatively into a second root (the same bytes), restored from a backup archive of its
 * generation (scripts/state-restore.ts's path), then GC runs as a dry run with the current generation as its keep set,
 * and the budget is read. Any failure exits 1.
 *
 * Then protocol 2 (storage phase 4.0, rehearseRefs): the lane refs on fresh `rehearsal-<run>-*` lanes, each property
 * the design's 4.0 gate names, observed and written to the job summary as a table (check, expected, observed,
 * verdict): R2's create-only precondition in both forms, the bootstrap twice and two racing bootstraps, two racing
 * writers on one ref (exactly one 412, several rounds), the ambiguous answer reconciled by the writer nonce (a dropped
 * answer, a request that never left, a real abort, a stale writer), the reflog's repair and create-only, at most 5
 * store operations per ref PUT, and the negative answers (428, 409, 426, the restore refused to the rehearsal). A
 * `fail` exits 1; a `warn` (R2's create-only not honoured) names the runbook bootstrap instead.
 *
 *   FEED_STATE_BACKEND=worker FEED_STATE_URL=https://feed-state-staging.theshelter.app \
 *   FEED_STATE_AUDIENCE=earthquakes-feed-state-staging npx --no-install tsx src/state-rehearsal.ts
 */

export const REHEARSAL_DAYS = 3;
const DAY_MS = 86_400_000;

function syntheticNode(run: string, i: number, eventTimeMs: number, lastSeq: number): EventNode {
  const iso = new Date(eventTimeMs).toISOString();
  return {
    feedId: `efd_rehearsal_${run}_${String(i).padStart(4, '0')}`,
    aliases: [`rehearsal:${run}:${i}`],
    eventTimeMs,
    firstIngestTime: iso,
    lastIngestTime: iso,
    lat: (i % 160) - 80,
    lon: ((i * 37) % 360) - 180,
    depth: 10,
    mag: 3 + (i % 30) / 10,
    magType: 'ml',
    status: 'automatic',
    place: 'synthetic rehearsal event',
    chosenProvider: 'rehearsal',
    provenance: [],
    revision: 1,
    firstSeenSeq: lastSeq,
    lastSeq,
    state: 'live',
    geohash: 'rehearsal',
  };
}

export async function rehearse(backend: StateBackend, opts: { nowMs?: number; log?: (l: string) => void; nodesPerDay?: number } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const nowMs = opts.nowMs ?? Date.now();
  const run = randomUUID().slice(0, 8);
  const steps: string[] = [];
  const step = (s: string): void => {
    steps.push(s);
    log(`rehearsal: ${s}`);
  };
  const a = mkdtempSync(join(tmpdir(), 'state-rehearsal-a-'));
  const b = mkdtempSync(join(tmpdir(), 'state-rehearsal-b-'));
  try {
    for (const r of [a, b]) {
      mkdirSync(dataPaths(r).indexDir, { recursive: true });
      writeFileSync(dataPaths(r).head, JSON.stringify({ seq: 1, ingest_time: new Date(nowMs).toISOString() }) + '\n');
    }
    const map = new Map<string, EventNode>();
    const perDay = opts.nodesPerDay ?? 200;
    for (let d = 0; d < REHEARSAL_DAYS; d++) {
      for (let i = 0; i < perDay; i++) {
        const n = syntheticNode(run, d * perDay + i, nowMs - (d + 0.5) * DAY_MS + i * 1000, 1);
        map.set(n.feedId, n);
      }
    }
    saveEventMap(a, map);
    const cutoffDay = new Date(nowMs - 45 * DAY_MS).toISOString().slice(0, 10);
    const p1 = await persist(a, backend, { cutoffDay });
    if (p1.uploaded.length !== REHEARSAL_DAYS) throw new Error(`persist uploaded ${p1.uploaded.length} day(s), expected ${REHEARSAL_DAYS}`);
    step(`persist: ${p1.uploaded.length} day blob(s) uploaded (${(p1.uploadedBytes / 1e3).toFixed(0)} kB)`);
    const h1 = await hydrate(a, backend, { mode: 'shadow' });
    if (h1.mismatches.length || h1.days !== REHEARSAL_DAYS) throw new Error(`shadow hydrate: ${h1.days} day(s), mismatches ${h1.mismatches.join('; ')}`);
    step(`shadow hydrate: ${h1.days} day(s) fetched and verified, identical to the checkout`);
    writeFileSync(dataPaths(a).head, JSON.stringify({ seq: 2, ingest_time: new Date(nowMs).toISOString() }) + '\n');
    const first = map.values().next().value!;
    map.set(first.feedId, { ...first, lastSeq: 2, place: 'revised synthetic rehearsal event' });
    saveEventMap(a, map);
    const p2 = await persist(a, backend, { cutoffDay });
    if (p2.uploaded.length !== 1 || !p2.written) throw new Error(`the second persist uploaded ${p2.uploaded.length} day(s), expected 1`);
    step(`persist after one revision: 1 day uploaded, generation at seq ${p2.headSeq}`);
    writeFileSync(dataPaths(b).generation, readFileSync(dataPaths(a).generation));
    writeFileSync(dataPaths(b).head, readFileSync(dataPaths(a).head));
    const h2 = await hydrate(b, backend, { mode: 'authoritative', env: {} });
    // The first root holds phase 3a's layout (saveEventMap's hour shards while git tracks the map), the second the
    // store's (one file per day): each day of the second is byte for byte canonicalDay of the first's files of it.
    const dirB = dataPaths(b).eventMapDir;
    const filesA = eventMapFiles(a);
    if (readdirSync(dirB).length !== filesA.size) throw new Error(`authoritative hydrate: ${readdirSync(dirB).length} file(s), the first root has ${filesA.size} day(s)`);
    for (const [day, names] of filesA) {
      if (readCanonicalDay(a, names).text !== readFileSync(join(dirB, dayFileName(day)), 'utf8')) throw new Error(`authoritative hydrate: ${day} differs`);
    }
    step(`authoritative hydrate into a second root: ${h2.written.length} day file(s), byte for byte the first root's days`);
    // The restore path (scripts/state-restore.ts) on the same synthetic state: the daily backup archive of the
    // generation, built, verified, and its blobs PUT again (the same keys: a restore into a store that kept them).
    const genText = readFileSync(dataPaths(a).generation, 'utf8');
    const blobs = await getBlobs(backend, Object.values(readGeneration(a)!.generation.days).map((e) => e.blob));
    const archive = readTar(decompressBackup(compressBackup(writeTar(backupMembers('0'.repeat(40), genText, new Map(), blobs)))));
    const restored = verifyBackup(archive);
    for (const e of Object.values(restored.generation.days)) await backend.put(e.blob, archive.get(casKey(e.blob))!);
    step(`restore: a backup archive of the generation verified and its ${Object.keys(restored.generation.days).length} blob(s) PUT again`);
    const current = Object.values(readGeneration(a)!.generation.days).map((e) => e.blob).sort();
    const gc = await collect(backend, { keep: current, current, windowFrom: '', boundaries: [], holdReason: null }, { dryRun: true });
    if (gc.skipped || gc.deleted !== 0) throw new Error(`GC dry run: ${gc.skipped ?? `deleted ${gc.deleted}`}`);
    step(`GC dry run (keep = the current generation, min age ${GC_MIN_AGE_DAYS} days): ${gc.pages} page(s), ${gcCounts(gc)}`);
    const budget = await backend.budget();
    step(`budget: ${budget ? budgetLine(budget) : `none (${backend.label} keeps no budget)`}`);
    return steps;
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Protocol 2: the lane refs

export type Verdict = 'ok' | 'warn' | 'fail';
export interface Observation {
  check: string;
  expected: string;
  observed: string;
  verdict: Verdict;
}

/** Racing-writer rounds: one round cannot tell an atomic CAS from luck, several make a lost race likely to show. */
export const RACE_ROUNDS = 6;
export const MAX_STORE_OPS = 5;

type FetchImpl = typeof globalThis.fetch;

export interface RefRehearsalOptions {
  /** A Worker backend whose fetch goes through `wrap` (the rehearsal drops or cuts answers with it). */
  make: (wrap?: (f: FetchImpl) => FetchImpl) => WorkerBackend;
  /** The writer id of a step (writerFromEnv on Actions; the token's run in tests). */
  writer: (step: string) => string;
  run?: string;
  nowMs?: number;
  log?: (l: string) => void;
}

/** The answer of a promise as data: a value or the error, never thrown (a race's two sides). */
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * The 4.0 gate on staging (state-rehearsal.yml): every property of the ref protocol the design needs proved on the
 * real binding, as observations. Never throws for a property that does not hold (that is an observation); throws only
 * when the rehearsal cannot go on (the store unreachable, a setup PUT refused).
 */
export async function rehearseRefs(opts: RefRehearsalOptions): Promise<Observation[]> {
  const log = opts.log ?? (() => {});
  const be = opts.make();
  const run = opts.run ?? randomUUID().slice(0, 8);
  const out: Observation[] = [];
  const note = (check: string, expected: string, observed: string, verdict: Verdict): void => {
    out.push({ check, expected, observed, verdict });
    log(`rehearsal refs: ${verdict.toUpperCase()} ${check}: ${observed}`);
  };
  const ops: number[] = [];
  const ledger: number[] = [];
  const track = (s: RefSwap | null): void => {
    if (s?.storeOps != null) ops.push(s.storeOps);
    if (s?.ledgerCalls != null) ledger.push(s.ledgerCalls);
  };
  let blobN = 0;
  /** A fresh synthetic generation blob in the store (each one unique to the run). */
  const generation = async (): Promise<string> => {
    const bytes = gzipSync(Buffer.from(`rehearsal generation ${run} ${blobN++}\n`));
    const hex = sha256Hex(bytes);
    await be.put(hex, bytes);
    return hex;
  };
  const commit = '0'.repeat(40);
  const make = (lane: string, cur: StateRef | null, gen: string, step: string, extra: Partial<StateRef> = {}): StateRef =>
    ({ ...nextRef(cur, { lane, generation: gen, head_seq: (cur?.head_seq ?? 0) + 1, data_commit: commit, writer: opts.writer(step) }), ...extra });

  // 1. R2's create-only precondition, both forms, on a key of its own (rehearsal/<lane>/…; staging only).
  const probeLane = `rehearsal-${run}-probe`;
  for (const form of ['headers', 'conditional'] as const) {
    const r = await be.rehearsalProbe(probeLane, { op: 'create-only', form });
    const held = r.first === 'created' && r.second === 'refused' && r.kept === 'probe 1';
    const used = form === 'headers' ? ' (the form the Worker uses)' : '';
    note(`R2 create-only, ${form === 'headers' ? 'If-None-Match: *' : 'etagDoesNotMatch "*"'}${used}`, 'created, then refused; the first body kept', `${String(r.first)}, then ${String(r.second)}; kept ${JSON.stringify(r.kept)}`, held ? 'ok' : form === 'headers' ? 'warn' : 'ok');
  }

  // 2. The bootstrap twice (the Worker's GET refuses the second), then two racing bootstraps (only the binding's
  //    create-only can refuse one of those).
  const laneA = `rehearsal-${run}-a`;
  const g1 = await generation();
  const first = make(laneA, null, g1, 'bootstrap');
  const created = await be.putRef(laneA, first, { create: true });
  track(created);
  const again = await settled(be.putRef(laneA, make(laneA, null, g1, 'bootstrap-again'), { create: true }));
  const againCurrent = !again.ok && again.error instanceof RefConflict ? again.error.current : null;
  note(
    'create twice (If-None-Match: *)',
    'the second answers 412 with the first ref',
    again.ok ? '200: the second create replaced the first' : again.error instanceof RefConflict ? `412, current = ${againCurrent?.ref.writer === first.writer ? 'the first ref' : 'another ref'}` : `error ${errText(again.error)}`,
    !again.ok && again.error instanceof RefConflict && againCurrent?.ref.writer === first.writer ? 'ok' : 'fail',
  );
  const laneB = `rehearsal-${run}-b`;
  const gb = await generation();
  const racers = [make(laneB, null, gb, 'race-create-1'), make(laneB, null, gb, 'race-create-2')];
  const createRace = await Promise.all(racers.map((r) => settled(be.putRef(laneB, r, { create: true }))));
  for (const r of createRace) if (r.ok) track(r.value);
  const createWins = createRace.filter((r) => r.ok).length;
  note(
    'two racing creates of one lane',
    'exactly one 200 and one 412',
    `${createWins} × 200, ${createRace.filter((r) => !r.ok && r.error instanceof RefConflict).length} × 412${createRace.some((r) => !r.ok && !(r.error instanceof RefConflict)) ? `, errors: ${createRace.filter((r) => !r.ok && !(r.error instanceof RefConflict)).map((r) => errText((r as { error: unknown }).error)).join('; ')}` : ''}`,
    createWins === 1 ? 'ok' : 'warn',
  );

  // 3. Racing writers on one ref, RACE_ROUNDS rounds: both name the same ETag; exactly one may win each round.
  let cur: RefRead | null = await be.getRef(laneA);
  if (!cur) throw new Error(`lane ${laneA}: no ref after its bootstrap`);
  let doubleWins = 0;
  let cleanRounds = 0;
  let metAtStore = 0;
  let wrongCurrent = 0;
  let slotTaken = 0;
  for (let round = 1; round <= RACE_ROUNDS; round++) {
    const gens = [await generation(), await generation()];
    const pair = gens.map((g, i) => make(laneA, cur!.ref, g, `race-${round}-${i + 1}`));
    const res = await Promise.all(pair.map((r) => settled(be.putRef(laneA, r, { etag: cur!.etag }))));
    const wins = res.flatMap((r, i) => (r.ok ? [{ swap: r.value, ref: pair[i]! }] : []));
    const lost = res.filter((r) => !r.ok && r.error instanceof RefConflict);
    for (const w of wins) {
      track(w.swap);
      if (w.swap.reflog.entry === 'exists') slotTaken++;
    }
    if (wins.length > 1) doubleWins++;
    if (wins.length === 1 && lost.length === 1) {
      cleanRounds++;
      const loser = (lost[0] as { error: RefConflict }).error;
      if (loser.current?.ref.writer !== wins[0]!.ref.writer) wrongCurrent++;
      if (loser.at === 'swap') metAtStore++;
    }
    const after = await be.getRef(laneA);
    if (!after) throw new Error(`lane ${laneA}: the ref vanished in race round ${round}`);
    cur = after;
  }
  const raceHeld = doubleWins === 0 && slotTaken === 0 && cleanRounds === RACE_ROUNDS && wrongCurrent === 0;
  note(
    `two racing writers on one ref (${RACE_ROUNDS} rounds)`,
    'every round exactly one 200 and one 412 whose body is the winner',
    `${cleanRounds} clean round(s), ${doubleWins} with two 200s, ${wrongCurrent} 412(s) naming another ref, ${slotTaken} reflog slot(s) already taken`,
    raceHeld ? 'ok' : 'fail',
  );
  // A loser refused by the Worker's GET never reached the conditional put: only a 412 from the put itself shows the
  // binding's CAS deciding between two writers that both passed the read check.
  note(
    'racers that met at the conditional put',
    'at least one 412 refused by the put itself (both passed the read check)',
    `${metAtStore} of ${cleanRounds} 412(s) came from the put, ${cleanRounds - metAtStore} from the Worker's read check`,
    metAtStore > 0 || !raceHeld ? 'ok' : 'warn',
  );

  // 4. The ambiguous answer: (a) the answer dropped after the Worker swapped, (b) a request that never left, (c) a real
  //    abort a few ms in (either may have happened: the outcome is observed), (d) a stale writer after another's swap.
  const dropAfter = opts.make((f) => async (input, init) => {
    const res = await f(input, init);
    if ((init?.method ?? 'GET') !== 'PUT' || !String(input).includes('/v1/refs/')) return res;
    await res.arrayBuffer().catch(() => {});
    throw new TypeError('fetch failed (the rehearsal dropped the answer)');
  });
  const neverSent = (() => {
    let dropped = false;
    return opts.make((f) => async (input, init) => {
      if (!dropped && (init?.method ?? 'GET') === 'PUT' && String(input).includes('/v1/refs/')) {
        dropped = true;
        throw new TypeError('fetch failed (the rehearsal never sent it)');
      }
      return f(input, init);
    });
  })();
  const abortSoon = (() => {
    let cut = false;
    return opts.make((f) => async (input, init) => {
      if (!cut && (init?.method ?? 'GET') === 'PUT' && String(input).includes('/v1/refs/')) {
        cut = true;
        return f(input, { ...init, signal: AbortSignal.timeout(5) });
      }
      return f(input, init);
    });
  })();
  const ambiguous: [string, WorkerBackend, string[]][] = [
    ['the answer dropped after the swap', dropAfter, ['reconciled']],
    ['a request that never left', neverSent, ['retried']],
    ['a real abort 5 ms in', abortSoon, ['reconciled', 'retried', 'swapped', 'landed-before']],
  ];
  for (const [what, client, expected] of ambiguous) {
    const ref = make(laneA, cur.ref, await generation(), `ambiguous-${expected[0]}`);
    const r = await settled(swapRef(client, laneA, ref, { etag: cur.etag }));
    const now = await be.getRef(laneA);
    const ours = now?.ref.writer === ref.writer;
    note(`ambiguous outcome: ${what}`, `${expected.join(' or ')}, and the ref is ours`, r.ok ? `${r.value.outcome} after ${r.value.attempts} PUT(s); the ref is ${ours ? 'ours' : 'NOT ours'}` : `error ${errText(r.error)}`, r.ok && expected.includes(r.value.outcome) && ours ? 'ok' : 'fail');
    if (now) cur = now;
  }
  const stale = cur;
  const moved = make(laneA, cur.ref, await generation(), 'stale-other');
  track(await be.putRef(laneA, moved, { etag: cur.etag }));
  cur = (await be.getRef(laneA))!;
  const late = await settled(swapRef(dropAfter, laneA, make(laneA, stale.ref, await generation(), 'stale-late'), { etag: stale.etag }));
  note('a stale writer after another swap', 'RefConflict (412), fail closed', late.ok ? `${late.value.outcome}: it swapped` : late.error instanceof RefConflict ? '412: RefConflict' : `error ${errText(late.error)}`, !late.ok && late.error instanceof RefConflict ? 'ok' : 'fail');

  // 5. The reflog: a dropped entry repaired by the next PUT, then left alone (create-only) by the one after it.
  await be.rehearsalProbe(laneA, { op: 'drop-reflog', seq: cur.ref.seq });
  const r1 = await be.putRef(laneA, make(laneA, cur.ref, await generation(), 'repair-1'), { etag: cur.etag });
  track(r1);
  cur = (await be.getRef(laneA))!;
  const r2 = await be.putRef(laneA, make(laneA, cur.ref, await generation(), 'repair-2'), { etag: cur.etag });
  track(r2);
  cur = (await be.getRef(laneA))!;
  note('reflog repair, then create-only', 'previous = repaired, then present', `${r1.reflog.previous}, then ${r2.reflog.previous}`, r1.reflog.previous === 'repaired' && r2.reflog.previous === 'present' ? 'ok' : 'fail');
  const entries = await reflogAll(be, laneA);
  const contiguous = entries.length === cur.ref.seq && entries.every((e, i) => e.seq === i + 1);
  const headMatches = entries.at(-1)?.generation === cur.ref.generation && entries.at(-1)?.writer === cur.ref.writer;
  note('reflog complete', `seq 1..${cur.ref.seq}, the last = the ref`, `${entries.length} entries, ${contiguous ? 'contiguous' : 'with gaps'}, last ${headMatches ? '= the ref' : '≠ the ref'}`, contiguous && headMatches ? 'ok' : 'fail');

  // 6. The answers a writer must never get past.
  const okRef = make(laneA, cur.ref, await generation(), 'negative');
  const text = canonicalJson(okRef);
  const raw = async (body: string, headers: Record<string, string>): Promise<number> => (await be.rawRef('PUT', laneA, body, { 'x-feed-state-protocol': '2', ...headers })).status;
  const negatives: [string, number, number][] = [
    ['no If-Match nor If-None-Match', 428, await raw(text, {})],
    ['seq not current + 1', 409, await raw(canonicalJson({ ...okRef, seq: okRef.seq + 1 }), { 'if-match': cur.etag })],
    ['a generation blob that is not in the store', 409, await raw(canonicalJson({ ...okRef, generation: sha256Hex(`absent ${run}`) }), { 'if-match': cur.etag })],
    ['protocol 1', 426, await raw(text, { 'if-match': cur.etag, 'x-feed-state-protocol': '1' })],
    ['a body that is not canonical', 400, await raw(JSON.stringify(okRef, null, 1), { 'if-match': cur.etag })],
    ['a restore from the rehearsal workflow', 403, await raw(canonicalJson({ ...okRef, head_seq: okRef.head_seq + 1000, restore_of: { seq: 1, generation: g1 } }), { 'if-match': cur.etag })],
  ];
  for (const [what, want, got] of negatives) note(`refused: ${what}`, String(want), String(got), got === want ? 'ok' : 'fail');

  // 7. The subrequest bound.
  const maxOps = ops.length ? Math.max(...ops) : null;
  note(`store operations per ref PUT (≤ ${MAX_STORE_OPS})`, `≤ ${MAX_STORE_OPS} on every PUT`, maxOps == null ? 'not reported' : `max ${maxOps} over ${ops.length} PUT(s); budget ledger calls max ${ledger.length ? Math.max(...ledger) : '?'}`, maxOps != null && maxOps <= MAX_STORE_OPS ? 'ok' : 'fail');

  // 8. The ledger saw it.
  const budget = await be.budget();
  note('budget ledger', 'ref conflicts counted, meta bytes held', `${budget.used.ref_conflicts ?? '?'} ref conflict(s) today, meta ${budget.meta_bytes ?? '?'} bytes, refused ${budget.used.refused} (critical ${budget.used.refused_critical ?? '?'})`, (budget.used.ref_conflicts ?? 0) > 0 && (budget.meta_bytes ?? 0) > 0 ? 'ok' : 'fail');
  return out;
}

/** The observations as a Markdown table, with what a `warn` or `fail` means for the next step. */
export function observationsMarkdown(obs: Observation[]): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = obs.map((o) => `| ${cell(o.check)} | ${cell(o.expected)} | ${cell(o.observed)} | ${o.verdict === 'ok' ? 'ok' : o.verdict.toUpperCase()} |`);
  const lines = ['| Check | Expected | Observed | Verdict |', '|---|---|---|---|', ...rows];
  const failed = obs.filter((o) => o.verdict === 'fail');
  const warned = obs.filter((o) => o.verdict === 'warn');
  if (failed.some((o) => /racing writers|reflog/.test(o.check))) {
    lines.push('', '**The R2 conditional put is not an atomic compare-and-swap here:** move the refs to the Durable Object (`REF_BACKEND = "do"`, state/README.md "Ref backend") and rehearse again before 4.1.');
  }
  if (warned.some((o) => o.check.startsWith('racers that met'))) {
    lines.push('', '**The racers never met at the conditional put:** every loser was refused by the Worker\'s read check, so the binding\'s CAS was not exercised. Dispatch the rehearsal again before treating the race as proved.');
  }
  if (warned.some((o) => !o.check.startsWith('racers that met'))) {
    lines.push('', `**R2's create-only precondition was not honoured (${warned.filter((o) => !o.check.startsWith('racers that met')).map((o) => o.check).join('; ')}):** a lane's first ref is written by the runbook bootstrap (state/README.md), under the writer lock, never by two jobs at once.`);
  }
  if (!failed.length && !warned.length) lines.push('', 'Every property of the 4.0 gate held.');
  return lines.join('\n');
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!/staging/.test(env.FEED_STATE_URL ?? '') || !/staging/.test(env.FEED_STATE_AUDIENCE ?? '')) {
    console.error('::error::the rehearsal runs against the staging store only (FEED_STATE_URL and FEED_STATE_AUDIENCE naming staging)');
    return 3;
  }
  const backend = backendFromEnv(env);
  if (!backend) {
    console.error('::error::FEED_STATE_BACKEND is not set');
    return 3;
  }
  const steps = await rehearse(backend, { log: (l) => console.log(l) });
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `### State store rehearsal (staging)\n\n${steps.map((s) => `- ${s}`).join('\n')}\n`, { flag: 'a' });
  if (!(backend instanceof WorkerBackend)) return 0;
  const obs = await rehearseRefs({
    make: (wrap) => {
      const b = backendFromEnv(env, { fetchImpl: wrap ? wrap(globalThis.fetch) : undefined });
      if (!(b instanceof WorkerBackend)) throw new StateStoreError('the protocol-2 rehearsal needs the Worker backend', 'config');
      return b;
    },
    writer: (step) => writerFromEnv(step, env),
    log: (l) => console.log(l),
  });
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `\n### Protocol 2: lane refs (staging)\n\n${observationsMarkdown(obs)}\n`, { flag: 'a' });
  for (const o of obs) if (o.verdict !== 'ok') console.log(`::${o.verdict === 'fail' ? 'error' : 'warning'}::state rehearsal: ${o.check}: ${o.observed}`);
  return obs.some((o) => o.verdict === 'fail') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`::error::state rehearsal: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
