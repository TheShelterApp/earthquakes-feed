// Types of scripts/remerge-commit.mjs (dependency-free, run by remerge.yml's commit job without npm ci).
export interface PendingMonth {
  period: string;
  base_sha256: string;
  entry: Record<string, unknown> & { period: string; asset: string; sha256: string };
  remediation_editions: (Record<string, unknown> & { tag: string; asset: string; day: string })[];
}
export interface Pending {
  version: 1;
  epoch: number;
  months: PendingMonth[];
  unused: { tag: string; asset: string; reason: string; seen_at: string }[];
}
export function previousOf(e: Record<string, unknown>): Record<string, unknown>;
export function applyPending(
  archives: { list: Record<string, any>[]; unused?: Record<string, any>[] },
  remediation: { editions: Record<string, any>[] },
  pending: Pick<Pending, 'months' | 'unused'>,
): { applied: string[]; dropped: string[] };
export function rollback(
  idx: { archives: { list: Record<string, any>[] } | null; history: { editions: Record<string, any>[] } | null; remediation: { editions: Record<string, any>[] } | null },
  epoch: number,
  o: { periods?: string[] | null; at: string; reason: string },
): { archives: string[]; history: string[]; remediation: string[]; problems: string[] };
export function archivesText(a: { list: Record<string, any>[] }): string;
export function remediationText(idx: Record<string, any>): string;
export function historyText(idx: Record<string, any>): string;
