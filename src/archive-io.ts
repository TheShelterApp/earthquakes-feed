import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './config.js';
import { featureToNode } from './bitemporal.js';
import type { EventNode } from './types.js';

const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8' });

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
 * that has already been rolled out of the tree. Best-effort: a month whose download/extract
 * fails yields no nodes (that day is left untouched, logged upstream). Requires gh + zstd.
 */
export function readArchivedDays(entries: ArchiveRef[], dayKeys: Set<string>): Map<string, EventNode[]> {
  const out = new Map<string, EventNode[]>();
  if (!dayKeys.size) return out;
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
        gh(['release', 'download', e.tag, '-R', REPO, '-p', e.asset, '-O', asset, '--clobber']);
        mkdirSync(dir, { recursive: true });
        extractTarball(asset, dir);
      } catch (err) {
        console.error(`backfill: could not fetch archive ${e.tag}/${e.asset}: ${String(err).slice(0, 140)}`);
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
  return out;
}
