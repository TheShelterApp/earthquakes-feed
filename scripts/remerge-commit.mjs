// The commit side of the archive re-merge (.github/workflows/remerge.yml; src/remerge-archives.ts; APIs.md, Re-merged
// history). Dependency-free on purpose: the commit job runs it with the runner's node on a sparse checkout, without
// `npm ci`.
//
//   node scripts/remerge-commit.mjs apply <pending.json> <data dir>
//       apply the collect job's results to knowledge/index/archives.json and remediation.json, compare-and-set: a
//       month is applied only when its entry still has the checksum the result was built on and no `needs_reroll`;
//       anything else is dropped (the next run merges the month again, or adopts the uploaded asset).
//   node scripts/remerge-commit.mjs rollback <epoch> [<YYYY-MM,...>] <data dir>
//       withdraw what the epoch published (scripts/remerge-rollback.ts runs the same function locally): each archive
//       entry merged to the epoch goes back to its previous[0] asset (the merged one stays listed with withdrawn_at and a
//       reason), each history edition and remediation edition of the epoch gets `withdrawn`. No asset is deleted.
//
// Both write the files in place; the workflow stages them and refuses anything else.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'TheShelterApp/earthquakes-feed';
const assetUrl = (tag, asset) => `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

/** The entry's asset as a previous[] item. */
export function previousOf(e) {
  return {
    asset: e.asset,
    sha256: e.sha256,
    bytes: e.bytes,
    count: e.count,
    edition: e.edition ?? 1,
    days: e.days,
    ...(e.merge_epoch != null ? { merge_epoch: e.merge_epoch } : {}),
  };
}

/**
 * Apply `pending` ({ months: [{ period, base_sha256, entry, remediation_editions }], unused }) to `archives` and
 * `remediation` (both changed in place). Returns { applied: [period], dropped: [`period: why`] }.
 */
export function applyPending(archives, remediation, pending) {
  const applied = [];
  const dropped = [];
  for (const m of pending.months ?? []) {
    const i = archives.list.findIndex((e) => e.period === m.period);
    const cur = archives.list[i];
    if (!cur) {
      dropped.push(`${m.period}: no archive entry`);
      continue;
    }
    if (cur.sha256 !== m.base_sha256) {
      dropped.push(`${m.period}: the entry moved on (${cur.sha256.slice(0, 12)}, built on ${m.base_sha256.slice(0, 12)})`);
      continue;
    }
    if (cur.needs_reroll) {
      dropped.push(`${m.period}: the month waits for a re-roll`);
      continue;
    }
    archives.list[i] = { ...m.entry, previous: [previousOf(cur), ...(cur.previous ?? [])] };
    for (const ed of m.remediation_editions ?? []) {
      if (!remediation.editions.some((x) => x.tag === ed.tag && x.asset === ed.asset)) remediation.editions.push(ed);
    }
    applied.push(m.period);
  }
  for (const u of pending.unused ?? []) {
    archives.unused ??= [];
    if (!archives.unused.some((x) => x.tag === u.tag && x.asset === u.asset)) archives.unused.push(u);
  }
  return { applied, dropped };
}

/**
 * Withdraw epoch `epoch` (optionally only `periods`) from the three indexes (changed in place). Returns what it did.
 */
export function rollback({ archives, history, remediation }, epoch, { periods = null, at, reason }) {
  const inScope = (period) => !periods || periods.includes(period);
  const out = { archives: [], history: [], remediation: [], problems: [] };
  for (let i = 0; i < (archives?.list ?? []).length; i++) {
    const e = archives.list[i];
    if (e.merge_epoch !== epoch || !inScope(e.period)) continue;
    const [prev, ...rest] = e.previous ?? [];
    if (!prev) {
      out.problems.push(`${e.period}: merged to epoch ${epoch} but lists no previous asset`);
      continue;
    }
    const { live: _l, superseded: _s, built_on: _b, remediation: _r, merge_epoch: _m, previous: _p, edition: _e, ...base } = e;
    archives.list[i] = {
      ...base,
      asset: prev.asset,
      url: assetUrl(e.tag, prev.asset),
      sha256: prev.sha256,
      bytes: prev.bytes,
      count: prev.count,
      ...(prev.days ? { days: prev.days } : {}),
      ...(prev.edition > 1 ? { edition: prev.edition } : {}),
      ...(prev.merge_epoch != null ? { merge_epoch: prev.merge_epoch } : {}),
      previous: [{ ...previousOf(e), withdrawn_at: at, reason }, ...rest],
    };
    out.archives.push(`${e.period}: ${e.asset} -> ${prev.asset}`);
  }
  for (const e of history?.editions ?? []) {
    if (e.merge_epoch !== epoch || !e.merged_from || e.withdrawn || !inScope(e.period)) continue;
    e.withdrawn = { at, reason };
    out.history.push(`${e.period}: ${e.asset}`);
  }
  for (const e of remediation?.editions ?? []) {
    // Only the refreshed editions (from_edition > 0): an edition merged as it was built carries new rows and stays.
    if (e.stats?.remerge?.epoch !== epoch || !(e.stats.remerge.from_edition > 0) || e.withdrawn || !inScope(e.day.slice(0, 7))) continue;
    e.withdrawn = { at, reason };
    out.remediation.push(`${e.day}: ${e.asset}`);
  }
  return out;
}

// --- the index files, written as their own writers write them ---

const paths = (dir) => ({
  archives: join(dir, 'knowledge/index/archives.json'),
  remediation: join(dir, 'knowledge/index/remediation.json'),
  history: join(dir, 'knowledge/index/history.json'),
});
const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);

/** archives.json: src/archive.ts saveArchives (period order, 2-space JSON). */
export function archivesText(a) {
  a.list.sort((x, y) => (x.period < y.period ? -1 : 1));
  return JSON.stringify(a, null, 2) + '\n';
}
/** remediation.json: src/remediation.ts indexText (the order of raw and editions, the refill queue as it is). */
export function remediationText(idx) {
  const raw = [...(idx.raw ?? [])].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.provider < b.provider ? -1 : 1));
  const editions = [...(idx.editions ?? [])].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.edition - b.edition));
  return JSON.stringify({ version: 1, raw, editions, refill_queue: idx.refill_queue ?? [] }, null, 2) + '\n';
}
/** history.json: src/history-index.ts indexText (one line per entry). */
export function historyText(idx) {
  idx.raw.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : a.asset < b.asset ? -1 : 1));
  idx.editions.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.edition - b.edition));
  idx.unused.sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
  const attempts = Object.entries(idx.attempts ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const list = (xs) => (xs.length ? `[\n${xs.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]` : '[]');
  const att = attempts.length ? `{\n${attempts.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n  }` : '{}';
  return (
    `{\n  "version": ${idx.version},\n  "boundary": ${JSON.stringify(idx.boundary)},\n  "raw": ${list(idx.raw)},\n` +
    `  "editions": ${list(idx.editions)},\n  "unused": ${list(idx.unused)},\n  "attempts": ${att}\n}\n`
  );
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'apply') {
    const [pendingFile, dir] = rest;
    const p = paths(dir);
    const pending = JSON.parse(readFileSync(pendingFile, 'utf8'));
    const archives = readJson(p.archives, { list: [] });
    const remediation = readJson(p.remediation, { version: 1, raw: [], editions: [] });
    const res = applyPending(archives, remediation, pending);
    writeFileSync(p.archives, archivesText(archives));
    writeFileSync(p.remediation, remediationText(remediation));
    console.log(`remerge commit: applied ${res.applied.length} month(s) (${res.applied.join(', ') || 'none'}), dropped ${res.dropped.length}`);
    for (const d of res.dropped) console.log(`::warning::remerge commit: dropped ${d}; merged again next run`);
    return;
  }
  if (mode === 'rollback') {
    const dir = rest.pop();
    const epoch = Number(rest[0]);
    const periods = rest[1] ? rest[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error(`rollback: epoch ${rest[0]} is not a positive integer`);
    const p = paths(dir);
    const idx = { archives: readJson(p.archives, null), history: readJson(p.history, null), remediation: readJson(p.remediation, null) };
    const res = rollback(idx, epoch, { periods, at: new Date().toISOString(), reason: `rollback of re-merge epoch ${epoch}` });
    if (idx.archives) writeFileSync(p.archives, archivesText(idx.archives));
    if (idx.history) writeFileSync(p.history, historyText(idx.history));
    if (idx.remediation) writeFileSync(p.remediation, remediationText(idx.remediation));
    console.log(`remerge rollback of epoch ${epoch}: ${res.archives.length} archive month(s), ${res.history.length} history edition(s), ${res.remediation.length} remediation edition(s) withdrawn`);
    for (const x of res.problems) console.log(`::error::remerge rollback: ${x}`);
    if (res.problems.length) process.exitCode = 1;
    return;
  }
  throw new Error('usage: remerge-commit.mjs apply <pending.json> <data dir> | rollback <epoch> [<YYYY-MM,...>] <data dir>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
