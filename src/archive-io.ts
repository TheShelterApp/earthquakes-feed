import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './config.js';
import { featureToNode } from './bitemporal.js';
import { ghRetry } from './gh.js';
import type { EventNode } from './types.js';

/** Extract an archive asset (.tar.zst or .tar.gz) into a directory. */
function extractTarball(file: string, intoDir: string): void {
  if (file.endsWith('.zst')) {
    const tar = file.replace(/\.zst$/, '');
    execFileSync('zstd', ['-d', '-q', '-f', file, '-o', tar]);
    execFileSync('tar', ['-xf', tar, '-C', intoDir]);
  } else {
    execFileSync('tar', ['-xzf', file, '-C', intoDir]);
  }
}

export interface ArchiveRef {
  period: string; // YYYY-MM
  tag: string;
  asset: string;
  days?: string[];
}

/**
 * Fetch cold months back from GitHub Releases and reconstruct EventNodes for the requested
 * archived day keys. Lets backfill dedup a NEW source against — and merge it into — history
 * that has already been rolled out of the tree. Requires gh + zstd.
 *
 * A month whose download/extract fails yields no nodes AND is reported in `failedMonths`: its
 * history is simply unknown to this process. The caller MUST treat every day of such a month as
 * untouchable — writing one from the rows it happens to hold replaces the month's full history
 * with a fragment (2026-07: −34.5k events across four months, all runs green).
 */
export function readArchivedDays(entries: ArchiveRef[], dayKeys: Set<string>): { days: Map<string, EventNode[]>; failedMonths: Set<string> } {
  const out = new Map<string, EventNode[]>();
  const failedMonths = new Set<string>();
  if (!dayKeys.size) return { days: out, failedMonths };
  const byMonth = new Map<string, ArchiveRef>();
  for (const e of entries) byMonth.set(e.period, e);
  const monthsNeeded = new Set([...dayKeys].map((d) => d.slice(0, 7)));
  const staging = mkdtempSync(join(tmpdir(), 'efd-bf-arch-'));
  try {
    for (const month of monthsNeeded) {
      const e = byMonth.get(month);
      if (!e) continue;
      const dir = join(staging, month);
      const asset = join(staging, e.asset);
      try {
        ghRetry(['release', 'download', e.tag, '-R', REPO, '-p', e.asset, '-O', asset, '--clobber']);
        mkdirSync(dir, { recursive: true });
        extractTarball(asset, dir);
      } catch (err) {
        failedMonths.add(month);
        console.error(`::error::backfill: could not fetch archive ${e.tag}/${e.asset}: ${String(err).replace(/\s+/g, ' ')}`);
        continue;
      }
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.ndjson')) continue;
        const day = `${month}-${f.slice(0, 2)}`; // member files are DD.ndjson
        if (!dayKeys.has(day)) continue;
        const nodes: EventNode[] = [];
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
          if (line.trim()) nodes.push(featureToNode(JSON.parse(line)));
        }
        out.set(day, nodes);
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { days: out, failedMonths };
}
