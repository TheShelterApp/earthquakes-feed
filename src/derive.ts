import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, EVENT_MAP_HORIZON_DAYS, JSDELIVR_BASE, PUBLIC_DIR, REPO, SCHEMA_VERSION, dataPaths } from './config.js';
import { loadState, pruneEventMapShards, writeIfChanged } from './bitemporal.js';
import {
  loadInventory,
  manifestPartitions,
  saveInventory,
  writeDayPartition,
  type Inventory,
} from './partitions.js';
import { summaries, summaryFeats } from './summaries.js';
import type { EventNode } from './types.js';
import { eventDayKey } from './bitemporal.js';
import { isoFromMs } from './util.js';
import { enrichStatusV2, updateProviderHealth, type AggregateStatus, type ProviderHealth } from './status-v2.js';
import { appendChanges } from './changes.js';
import { FRESHNESS_EXPECTED_INTERVAL_SECONDS, FRESHNESS_STALE_AFTER_SECONDS } from './freshness.js';
import { pagesHeaders } from './pages-headers.js';

function main(): void {
  const nowMs = Date.now();
  const state = loadState(DATA_DIR, { sinceDays: EVENT_MAP_HORIZON_DAYS, nowMs });
  const publicV1 = join(PUBLIC_DIR, 'v1');
  const allNodes = [...state.eventMap.values()];

  // Summaries: live events plus the recently superseded ones flagged non-live (summaryFeats),
  // compact — the full superset stays in the day files/partitions written below.
  const feats = summaryFeats(allNodes, nowMs);
  const liveCount = feats.filter((f) => f.live).length;
  const summ = summaries(feats, nowMs, publicV1, state.head.ingest_time);

  // Partitions: every state, one file per event-day, only for the days we loaded.
  const byDay = new Map<string, EventNode[]>();
  for (const n of allNodes) (byDay.get(eventDayKey(n.eventTimeMs)) ?? byDay.set(eventDayKey(n.eventTimeMs), []).get(eventDayKey(n.eventTimeMs))!).push(n);
  const inv: Inventory = loadInventory(DATA_DIR);
  let rewritten = 0;
  for (const [day, nodes] of byDay) {
    const { written, stat } = writeDayPartition(DATA_DIR, day, nodes, { publicV1, nowMs, headIngestTime: state.head.ingest_time });
    if (written) rewritten++;
    inv[day] = stat;
  }
  saveInventory(DATA_DIR, inv);
  // Days whose Pages day file exists in THIS deploy snapshot (drives truthful pages_url).
  const pagesDays = new Set(byDay.keys());

  const manifest = JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      generated: nowMs,
      generated_iso: isoFromMs(nowMs),
      head_seq: state.head.seq,
      event_count: liveCount,
      freshness: { expected_interval_seconds: 300, stale_after_seconds: 1800 },
      data_repo: REPO,
      jsdelivr_base: `${JSDELIVR_BASE}@data`,
      // Injected post-commit into the Pages manifest (derive.yml). For an immutable copy
      // of any frozen partition: `${jsdelivr_base%@data}@<data_commit>/<partition.path>`.
      data_commit: null,
      summaries: summ,
      partitions: manifestPartitions(inv, nowMs, pagesDays),
      archives: loadArchives(),
    },
    null,
    2,
  );
  writeIfChanged(join(publicV1, 'manifest.json'), manifest);
  writeIfChanged(join(DATA_DIR, 'manifest.json'), manifest);
  // One rule per published path (pages-headers.ts): Pages joins the headers of every matching rule.
  writeIfChanged(join(PUBLIC_DIR, '_headers'), pagesHeaders(nowMs, pagesDays));

  // Publish the last aggregate's per-provider health onto Pages so /v1/status.json is a
  // real endpoint (documented in APIs.md, read by the health watchdog). It's written to
  // DATA_DIR by aggregate; without this copy it only lived on the data branch → 404.
  const paths = dataPaths(DATA_DIR);
  if (existsSync(paths.status)) {
    const raw = JSON.parse(readFileSync(paths.status, 'utf8')) as AggregateStatus;
    const generatedMs = Date.parse(raw.generated) || nowMs;
    // SD-E3: per-provider last-success history lives here (derive-owned), so lag is real.
    const prevHealth: ProviderHealth = existsSync(paths.providerHealth) ? (JSON.parse(readFileSync(paths.providerHealth, 'utf8')) as ProviderHealth) : {};
    const health = updateProviderHealth(prevHealth, raw.providers, generatedMs);
    writeIfChanged(paths.providerHealth, JSON.stringify(health) + '\n');
    const v2 = enrichStatusV2(raw, {
      generatedMs,
      expectedIntervalSeconds: FRESHNESS_EXPECTED_INTERVAL_SECONDS,
      staleAfterSeconds: FRESHNESS_STALE_AFTER_SECONDS,
      health,
      ...(process.env.RUN_ID ? { runId: process.env.RUN_ID } : {}),
    });
    writeIfChanged(join(publicV1, 'status.json'), JSON.stringify(v2, null, 2));
  }

  // SD-E3: append the idempotent change-log for this run (fan-out reads this, not state).
  const changesDay = isoFromMs(nowMs).slice(0, 10);
  const cursor = existsSync(paths.changesCursor) ? (JSON.parse(readFileSync(paths.changesCursor, 'utf8')) as { seq: number }).seq : 0;
  const changesFile = join(paths.changesDir, `${changesDay}.ndjson`);
  const changed = appendChanges(changesFile, allNodes, cursor);
  if (changed.appended > 0) {
    writeIfChanged(paths.changesCursor, JSON.stringify({ seq: changed.cursor, day: changesDay }) + '\n');
    // Mirror the day's change-log to Pages/R2 for hot tailing (Range from the last byte).
    mkdirSync(join(publicV1, 'changes'), { recursive: true });
    writeFileSync(join(publicV1, 'changes', `${changesDay}.ndjson`), readFileSync(changesFile));
  }
  console.log(`derive: status v2 + changes appended=${changed.appended} (seq→${changed.cursor})`);

  const pruned = pruneEventMapShards(DATA_DIR, nowMs - EVENT_MAP_HORIZON_DAYS * 86_400_000);

  console.log(
    `derive: live=${liveCount} summaries=${Object.keys(summ).length} partitions=${byDay.size} rewritten=${rewritten}` +
      (pruned.length ? ` pruned_shards=${pruned.length}` : ''),
  );
}

/** Archive catalog (regenerated from archives.json, source of truth written by archive.ts). */
function loadArchives(): unknown[] {
  const f = dataPaths(DATA_DIR).archivesIndex;
  if (!existsSync(f)) return [];
  return (JSON.parse(readFileSync(f, 'utf8')) as { list?: unknown[] }).list ?? [];
}

main();
