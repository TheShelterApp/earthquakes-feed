import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveEventMap } from './bitemporal.js';
import { dataPaths } from './config.js';
import { blobSizes, dayFileName, eventMapFiles, hydrate, persist, readCanonicalDay, readGeneration } from './event-map-store.js';
import { collect, gcCounts, GC_MIN_AGE_DAYS } from './state-gc.js';
import { backupMembers, compressBackup, decompressBackup, readTar, verifyBackup, writeTar } from './state-backup.js';
import { gzipSync } from 'node:zlib';
import {
  RefConflict,
  ReflogCollision,
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
 * `fail` exits 1; a `warn` passes; each names its remedy (Remedy: the DO fallback only for a CAS that is not atomic,
 * CREATE_ONLY_FORM for a create-only form the binding ignores, the runbook bootstrap, or another dispatch).
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
    // Every day, not the rotating sample of a production run: the rehearsal proves the store holds each blob it wrote.
    const h1 = await hydrate(a, backend, { mode: 'shadow', sample: REHEARSAL_DAYS });
    if (h1.mismatches.length || h1.days !== REHEARSAL_DAYS || h1.fetched.length !== REHEARSAL_DAYS) throw new Error(`shadow hydrate: ${h1.days} day(s), ${h1.fetched.length} fetched, mismatches ${h1.mismatches.join('; ')}`);
    step(`shadow hydrate: ${h1.fetched.length} day(s) fetched and verified in ${h1.batches} batch(es), identical to the checkout`);
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
    const genA = readGeneration(a)!.generation;
    const blobs = await getBlobs(backend, Object.values(genA.days).map((e) => e.blob), { sizes: blobSizes(genA) });
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

/** `info` reports without judging (the probe of a form the Worker does not use, its configuration). */
export type Verdict = 'ok' | 'info' | 'warn' | 'fail';
/**
 * What a `warn` or `fail` calls for, set by the check that observed it (observationsMarkdown words it):
 * - `do`: the R2 conditional put is not an atomic compare-and-swap (two 200s for one seq, a 412 naming another ref, a
 *   reflog slot taken by a racer): REF_BACKEND = "do";
 * - `create-only`: the configured CREATE_ONLY_FORM is not what the binding honours: set it to the form the probe proved
 *   (`hint`), never the DO fallback (the reflog stays in R2 there, with the same form);
 * - `runbook`: create-only is not in use or not atomic on R2: lanes are bootstrapped by the runbook;
 * - `redispatch`: the property was not exercised (a transient error, the racers never met at the put, the UTC day
 *   turned): dispatch the rehearsal again.
 */
export type Remedy = 'do' | 'create-only' | 'runbook' | 'redispatch';
export interface Observation {
  check: string;
  expected: string;
  observed: string;
  verdict: Verdict;
  remedy?: Remedy;
  hint?: string;
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
/** A 412 the Worker answered (its body names the check, `at`), not one swapRef concluded after an unknown outcome. */
const workerConflict = (e: unknown): e is RefConflict => e instanceof RefConflict && e.at != null;

/**
 * The 4.0 gate on staging (state-rehearsal.yml): every property of the ref protocol the design needs proved on the
 * real binding, as observations, judged against the Worker's own configuration (REF_BACKEND, CREATE_ONLY_FORM: every
 * probe answer carries it). Never throws: a property that does not hold is an observation, and a step that cannot go on
 * (the store unreachable, a setup PUT refused) ends the run with a `fail` row naming it, after the rows it has, so the
 * job summary always has its table.
 */
export async function rehearseRefs(opts: RefRehearsalOptions): Promise<Observation[]> {
  const log = opts.log ?? (() => {});
  const be = opts.make();
  const run = opts.run ?? randomUUID().slice(0, 8);
  const out: Observation[] = [];
  const note = (check: string, expected: string, observed: string, verdict: Verdict, remedy?: Remedy, hint?: string): void => {
    out.push({ check, expected, observed, verdict, ...(verdict === 'warn' || verdict === 'fail' ? { ...(remedy ? { remedy } : {}), ...(hint ? { hint } : {}) } : {}) });
    log(`rehearsal refs: ${verdict.toUpperCase()} ${check}: ${observed}`);
  };
  const ops: number[] = [];
  const ledger: number[] = [];
  const track = (s: RefSwap | null): void => {
    if (s?.storeOps != null) ops.push(s.storeOps);
    if (s?.ledgerCalls != null) ledger.push(s.ledgerCalls);
  };
  // What this run must have made the ledger count: the 412s the Worker answered it, and the meta bytes of every swap
  // that landed (its reflog entry; on a create the ref object too). Compared with the ledger's deltas in step 8.
  let seen412 = 0;
  let heldMeta = 0;
  const saw = (e: unknown): void => {
    if (workerConflict(e)) seen412++;
  };
  const landed = (ref: StateRef, create = false): void => {
    heldMeta += Buffer.byteLength(canonicalJson(ref)) * (create ? 2 : 1);
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

  // 1. R2's create-only precondition, both forms, on a key of its own (rehearsal/<lane>/…; staging only), and the
  //    Worker's configuration, which decides how every later row is judged.
  const probeLane = `rehearsal-${run}-probe`;
  const held: Record<'headers' | 'conditional', boolean | null> = { headers: null, conditional: null };
  let form = 'unknown';
  let refBackend = 'unknown';
  try {
    for (const f of ['headers', 'conditional'] as const) {
      const r = await be.rehearsalProbe(probeLane, { op: 'create-only', form: f });
      const worker = (r.worker ?? {}) as { create_only?: unknown; ref_backend?: unknown };
      form = String(worker.create_only ?? form);
      refBackend = String(worker.ref_backend ?? refBackend);
      held[f] = r.first === 'created' && r.second === 'refused' && r.kept === 'probe 1';
      const observed = `${String(r.first)}, then ${String(r.second)}; kept ${JSON.stringify(r.kept)}`;
      out.push({ check: `R2 create-only, ${f === 'headers' ? 'If-None-Match: *' : 'etagDoesNotMatch "*"'} ("${f}")`, expected: 'created, then refused; the first body kept', observed, verdict: 'info' });
    }
  } catch (e) {
    note('rehearsal aborted at the create-only probe', 'every step runs', `error ${errText(e)}`, 'fail', 'redispatch');
    return out;
  }
  // The probe rows judged now that the configured form is known: only the form the Worker uses gates.
  const proven = (['headers', 'conditional'] as const).find((f) => held[f]);
  const better = proven ? `CREATE_ONLY_FORM = "${proven}"` : 'CREATE_ONLY_FORM = "off" (no form held: lanes are then bootstrapped by the runbook)';
  for (const o of out) {
    const f = /\("(\w+)"\)$/.exec(o.check)?.[1];
    if (f !== form) continue;
    o.check += ', the configured form';
    if (held[f as 'headers' | 'conditional']) o.verdict = 'ok';
    else Object.assign(o, { verdict: 'fail', remedy: 'create-only', hint: better });
  }
  for (const o of out) log(`rehearsal refs: ${o.verdict.toUpperCase()} ${o.check}: ${o.observed}`);
  /** The Worker's reflog puts honour create-only (the configured form held); with "off" they are plain puts. */
  const createOnlyOn = form !== 'off';
  const formBroken = createOnlyOn && !(form === 'headers' || form === 'conditional' ? held[form] : false);
  note('Worker configuration', 'REF_BACKEND and CREATE_ONLY_FORM as deployed', `REF_BACKEND = "${refBackend}", CREATE_ONLY_FORM = "${form}"`, form === 'off' ? 'warn' : 'info', 'runbook');
  if (form !== 'off' && form !== 'headers' && form !== 'conditional') note('Worker configuration known', 'the probe names CREATE_ONLY_FORM', `"${form}": a Worker older than this rehearsal`, 'fail', 'redispatch');
  /** A failure caused by a create-only form the binding does not honour is that form's remedy, not its own. */
  const or = (r: Remedy): Remedy => (formBroken ? 'create-only' : r);

  const before = await settled(be.budget());
  try {
    await refRows();
  } catch (e) {
    note('rehearsal aborted', 'every step runs', `error ${errText(e)}`, 'fail', or('redispatch'), formBroken ? better : undefined);
  }
  return out;

  async function refRows(): Promise<void> {
    // 2. The bootstrap twice (the Worker's GET refuses the second), then two racing bootstraps (only the binding's
    //    create-only, or the Durable Object's row, can refuse one of those).
    const laneA = `rehearsal-${run}-a`;
    const g1 = await generation();
    const first = make(laneA, null, g1, 'bootstrap');
    track(await be.putRef(laneA, first, { create: true }));
    landed(first, true);
    const again = await settled(be.putRef(laneA, make(laneA, null, g1, 'bootstrap-again'), { create: true }));
    if (!again.ok) saw(again.error);
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
    createRace.forEach((r, i) => {
      if (r.ok) {
        track(r.value);
        landed(racers[i]!, true);
      } else saw(r.error);
    });
    const createWins = createRace.filter((r) => r.ok).length;
    const createLost = createRace.filter((r) => !r.ok && r.error instanceof RefConflict).length;
    const createErrors = createRace.flatMap((r) => (!r.ok && !(r.error instanceof RefConflict) ? [errText(r.error)] : []));
    // Two 200s: R2's create-only is not atomic (or is off): the runbook bootstraps lanes. The Durable Object's row
    // create cannot do that, so there it is a failure.
    note(
      'two racing creates of one lane',
      'exactly one 200 and one 412',
      `${createWins} × 200, ${createLost} × 412${createErrors.length ? `, errors: ${createErrors.join('; ')}` : ''}`,
      createWins === 1 && createLost === 1 ? 'ok' : createWins > 1 ? (refBackend === 'do' ? 'fail' : 'warn') : 'fail',
      createWins > 1 ? 'runbook' : or('redispatch'),
    );

    // 3. Racing writers on one ref, RACE_ROUNDS rounds: both name the same ETag; exactly one may win each round.
    let cur: RefRead | null = await be.getRef(laneA);
    if (!cur) throw new Error(`lane ${laneA}: no ref after its bootstrap`);
    let doubleWins = 0;
    let cleanRounds = 0;
    let metAtStore = 0;
    let wrongCurrent = 0;
    let slotTaken = 0;
    const roundErrors: string[] = [];
    for (let round = 1; round <= RACE_ROUNDS; round++) {
      const gens = [await generation(), await generation()];
      const pair = gens.map((g, i) => make(laneA, cur!.ref, g, `race-${round}-${i + 1}`));
      const res = await Promise.all(pair.map((r) => settled(be.putRef(laneA, r, { etag: cur!.etag }))));
      // A ReflogCollision is a win too (the ref moved) onto a taken reflog slot: the client failed it closed.
      const wins = res.flatMap((r, i) => (r.ok ? [{ swap: r.value, ref: pair[i]! }] : r.error instanceof ReflogCollision ? [{ swap: r.error.swap, ref: pair[i]! }] : []));
      const lost = res.filter((r) => !r.ok && r.error instanceof RefConflict);
      for (const r of res) if (!r.ok && !(r.error instanceof RefConflict) && !(r.error instanceof ReflogCollision)) roundErrors.push(`round ${round}: ${errText(r.error)}`);
      for (const r of res) if (!r.ok) saw(r.error);
      for (const w of wins) {
        track(w.swap);
        landed(w.ref);
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
    // Only two 200s, a 412 naming another ref or a racer's reflog slot taken show a CAS that is not atomic (the DO
    // fallback); an error (a 503, a cut connection) only means a round proved nothing, so the rehearsal runs again.
    const casBroken = doubleWins > 0 || wrongCurrent > 0 || slotTaken > 0;
    const raceHeld = !casBroken && cleanRounds === RACE_ROUNDS;
    note(
      `two racing writers on one ref (${RACE_ROUNDS} rounds)`,
      'every round exactly one 200 and one 412 whose body is the winner',
      `${cleanRounds} clean round(s), ${doubleWins} with two 200s, ${wrongCurrent} 412(s) naming another ref, ${slotTaken} reflog slot(s) already taken${createOnlyOn ? '' : ' (not detectable: CREATE_ONLY_FORM = "off")'}${roundErrors.length ? `; ${roundErrors.length} error(s): ${roundErrors.slice(0, 3).join('; ')}` : ''}`,
      raceHeld ? 'ok' : 'fail',
      casBroken ? 'do' : or('redispatch'),
    );
    // A loser refused by the Worker's GET never reached the conditional put: only a 412 from the put itself shows the
    // binding's CAS deciding between two writers that both passed the read check.
    note(
      'racers that met at the conditional put',
      'at least one 412 refused by the put itself (both passed the read check)',
      `${metAtStore} of ${cleanRounds} 412(s) came from the put, ${cleanRounds - metAtStore} from the Worker's read check`,
      metAtStore > 0 || !raceHeld ? 'ok' : 'warn',
      'redispatch',
    );

    // 4. The ambiguous answer: (a) the answer dropped after the Worker swapped, (b) a request that never left, (c) a real
    //    abort a few ms in (either may have happened: the outcome is observed), (d) a stale writer after another's swap,
    //    its 412 seen, and (e) the same with its answer dropped.
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
      if (r.ok) landed(ref);
      else saw(r.error);
      const now = await be.getRef(laneA);
      const ours = now?.ref.writer === ref.writer;
      note(
        `ambiguous outcome: ${what}`,
        `${expected.join(' or ')}, and the ref is ours`,
        r.ok ? `${r.value.outcome} after ${r.value.attempts} PUT(s); the ref is ${ours ? 'ours' : 'NOT ours'}` : `error ${errText(r.error)}`,
        r.ok && expected.includes(r.value.outcome) && ours ? 'ok' : 'fail',
        or('redispatch'),
      );
      if (now) cur = now;
    }
    const stale = cur;
    const moved = make(laneA, cur.ref, await generation(), 'stale-other');
    track(await be.putRef(laneA, moved, { etag: cur.etag }));
    landed(moved);
    cur = (await be.getRef(laneA))!;
    const lateSeen = await settled(swapRef(be, laneA, make(laneA, stale.ref, await generation(), 'stale-seen'), { etag: stale.etag }));
    if (!lateSeen.ok) saw(lateSeen.error);
    note(
      'a stale writer after another swap',
      'the Worker answers 412 (RefConflict), fail closed',
      lateSeen.ok ? `${lateSeen.value.outcome}: it swapped` : workerConflict(lateSeen.error) ? `412 (at: ${lateSeen.error.at}): RefConflict` : `error ${errText(lateSeen.error)}`,
      !lateSeen.ok && workerConflict(lateSeen.error) ? 'ok' : 'fail',
      or('redispatch'),
    );
    const lateLost = await settled(swapRef(dropAfter, laneA, make(laneA, stale.ref, await generation(), 'stale-lost'), { etag: stale.etag }));
    note(
      'a stale writer whose answer is lost',
      'RefConflict from the re-read (another writer\'s ref), fail closed',
      lateLost.ok ? `${lateLost.value.outcome}: it swapped` : lateLost.error instanceof RefConflict ? (lateLost.error.at == null ? 'RefConflict after the re-read' : `412 (at: ${lateLost.error.at})`) : `error ${errText(lateLost.error)}`,
      !lateLost.ok && lateLost.error instanceof RefConflict ? 'ok' : 'fail',
      or('redispatch'),
    );

    // 5. The reflog: a dropped entry repaired by the next PUT, then left alone (create-only) by the one after it. With
    //    CREATE_ONLY_FORM "off" both PUTs rewrite the current entry (its same bytes); the completeness row then shows
    //    the dropped entry back.
    await be.rehearsalProbe(laneA, { op: 'drop-reflog', seq: cur.ref.seq });
    const rep1 = make(laneA, cur.ref, await generation(), 'repair-1');
    const r1 = await be.putRef(laneA, rep1, { etag: cur.etag });
    track(r1);
    landed(rep1);
    cur = (await be.getRef(laneA))!;
    const rep2 = make(laneA, cur.ref, await generation(), 'repair-2');
    const r2 = await be.putRef(laneA, rep2, { etag: cur.etag });
    track(r2);
    landed(rep2);
    cur = (await be.getRef(laneA))!;
    const want = createOnlyOn ? ['repaired', 'present'] : ['rewritten', 'rewritten'];
    note(
      `reflog repair, then ${createOnlyOn ? 'create-only' : 'a plain rewrite (CREATE_ONLY_FORM = "off")'}`,
      `previous = ${want[0]}, then ${want[1]}`,
      `${r1.reflog.previous}, then ${r2.reflog.previous}`,
      r1.reflog.previous === want[0] && r2.reflog.previous === want[1] ? 'ok' : 'fail',
      'create-only',
      better,
    );
    const entries = await reflogAll(be, laneA);
    const contiguous = entries.length === cur.ref.seq && entries.every((e, i) => e.seq === i + 1);
    const headMatches = entries.at(-1)?.generation === cur.ref.generation && entries.at(-1)?.writer === cur.ref.writer;
    note('reflog complete', `seq 1..${cur.ref.seq}, the last = the ref`, `${entries.length} entries, ${contiguous ? 'contiguous' : 'with gaps'}, last ${headMatches ? '= the ref' : '≠ the ref'}`, contiguous && headMatches ? 'ok' : 'fail', or('redispatch'));

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
    for (const [what, wantStatus, got] of negatives) note(`refused: ${what}`, String(wantStatus), String(got), got === wantStatus ? 'ok' : 'fail');

    // 7. The subrequest bound.
    const maxOps = ops.length ? Math.max(...ops) : null;
    note(`store operations per ref PUT (≤ ${MAX_STORE_OPS})`, `≤ ${MAX_STORE_OPS} on every PUT`, maxOps == null ? 'not reported' : `max ${maxOps} over ${ops.length} PUT(s); budget ledger calls max ${ledger.length ? Math.max(...ledger) : '?'}`, maxOps != null && maxOps <= MAX_STORE_OPS ? 'ok' : 'fail');

    // 8. The ledger saw THIS run: its counters moved at least by what the run caused (another rehearsal of the day
    //    can only add to them; the counters themselves are cumulative, so their size alone proves nothing).
    const after = await be.budget();
    if (!before.ok) {
      note('budget ledger', 'this run\'s 412s counted and its ref and reflog bytes held', `no reading before the run: ${errText(before.error)}`, 'fail', 'redispatch');
      return;
    }
    const b0 = before.value;
    const dConf = (after.used.ref_conflicts ?? 0) - (b0.used.ref_conflicts ?? 0);
    const dMeta = (after.meta_bytes ?? 0) - (b0.meta_bytes ?? 0);
    const sameDay = after.day === b0.day;
    note(
      'budget ledger',
      `this run's 412s counted (≥ ${seen412}) and its ref and reflog bytes held (≥ ${heldMeta} bytes)`,
      `ref conflicts +${dConf}, meta bytes +${dMeta}${sameDay ? '' : ` (the UTC day turned: ${b0.day} → ${after.day})`}; refused today ${after.used.refused} (critical ${after.used.refused_critical ?? '?'})`,
      !sameDay ? 'warn' : dConf >= seen412 && seen412 > 0 && dMeta >= heldMeta && heldMeta > 0 ? 'ok' : 'fail',
      'redispatch',
    );
  }
}

/** The observations as a Markdown table, with what each `warn` or `fail` calls for (its remedy). */
export function observationsMarkdown(obs: Observation[]): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = obs.map((o) => `| ${cell(o.check)} | ${cell(o.expected)} | ${cell(o.observed)} | ${o.verdict === 'ok' || o.verdict === 'info' ? o.verdict : o.verdict.toUpperCase()} |`);
  const lines = ['| Check | Expected | Observed | Verdict |', '|---|---|---|---|', ...rows];
  const flagged = obs.filter((o) => o.verdict === 'warn' || o.verdict === 'fail');
  const by = (r: Remedy): Observation[] => flagged.filter((o) => o.remedy === r);
  const names = (os: Observation[]): string => os.map((o) => o.check).join('; ');
  if (by('do').length) {
    lines.push('', `**The R2 conditional put is not an atomic compare-and-swap here (${names(by('do'))}):** move the refs to the Durable Object (\`REF_BACKEND = "do"\`, state/README.md "Ref backend") and rehearse again before 4.1.`);
  }
  if (by('create-only').length) {
    const hint = by('create-only').find((o) => o.hint)?.hint ?? 'the form the create-only probe proved';
    lines.push('', `**The Worker's create-only form is not what the binding honours (${names(by('create-only'))}):** set ${hint} in state/wrangler.toml, deploy staging and rehearse again. Not a reason for the Durable Object: the reflog stays in R2 there, written with the same form.`);
  }
  if (by('runbook').length) {
    lines.push('', `**R2's create-only is not in use or not atomic (${names(by('runbook'))}):** a lane's first ref is written by the runbook bootstrap (state/README.md), under the writer lock, never by two jobs at once.`);
  }
  if (by('redispatch').length) {
    lines.push('', `**Not exercised (${names(by('redispatch'))}):** a transient error, racers that never met at the conditional put, or a turned UTC day; dispatch the rehearsal again before treating these as proved.`);
  }
  const other = flagged.filter((o) => !o.remedy);
  if (other.length) lines.push('', `**Failed (${names(other)}):** the protocol does not hold as built; fix the Worker before 4.1.`);
  if (!flagged.length) lines.push('', 'Every property of the 4.0 gate held.');
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
  for (const o of obs) if (o.verdict === 'warn' || o.verdict === 'fail') console.log(`::${o.verdict === 'fail' ? 'error' : 'warning'}::state rehearsal: ${o.check}: ${o.observed}`);
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
