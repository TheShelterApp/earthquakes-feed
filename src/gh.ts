import { execFileSync } from 'node:child_process';

export const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8' });

/** Block synchronously for `ms` (this whole pipeline is sync execFileSync). */
export const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Transient = GitHub eventual consistency / rate / plain network flakiness. `Not Found`
 * (case-insensitive) covers "release/asset not found"; "no assets to download" covers an
 * `upload --clobber`'s freshly-uploaded asset not yet listed at verify time; and the
 * TCP-level errors (connection reset/refused, broken pipe, dial/read tcp, i/o timeout)
 * cover the release-assets CDN dropping a download mid-flight (2024-09 verify: "read tcp
 * …: connection reset by peer") — all worth retrying, none classified transient before.
 */
export const isTransientGhError = (msg: string): boolean =>
  /HTTP (404|429|5\d\d)|rate limit|abuse|timed? ?out|i\/o timeout|EOF|ECONN|ETIMEDOUT|TLS|handshake|Not Found|no assets? to download|could not find|temporar|connection reset|reset by peer|connection refused|broken pipe|(dial|read) tcp|network is unreachable|no such host/i.test(
    msg,
  );

const NOT_FOUND = /HTTP 404|Not Found|could not find|no assets? to download/i;

/**
 * Transient MINUS the not-found family. For calls where an absent release/asset is the real
 * answer rather than eventual consistency (creating a release, re-probing a tag that should
 * exist by now), so a genuinely-missing target fails fast instead of burning 5 backoffs (~62s).
 */
export const isTransientNetGhError = (msg: string): boolean => isTransientGhError(msg) && !NOT_FOUND.test(msg);

function ghRetryWith(args: string[], attempts: number, transient: (msg: string) => boolean): string {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return gh(args);
    } catch (e) {
      lastErr = e;
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error)?.message ?? '');
      if (!transient(msg) || i === attempts - 1) break;
      const backoff = Math.min(30_000, 2_000 * 2 ** i);
      console.error(`gh ${args[0]} ${args[1]} failed (${i + 1}/${attempts}), retry in ${backoff / 1000}s: ${msg.trim().slice(0, 140)}`);
      sleepMs(backoff);
    }
  }
  throw lastErr;
}

/**
 * Run a `gh` command, retrying transient GitHub API failures with backoff. The Releases
 * upload/download endpoints 404 (or 5xx/429) for a short window right after a release is
 * created — GitHub eventual consistency. A bare call then aborts the entire archive run
 * mid-way (2026-01 upload: `HTTP 404 .../releases/<id>/assets`). Non-transient errors
 * still fail loudly on the first try.
 */
export function ghRetry(args: string[], attempts = 5): string {
  return ghRetryWith(args, attempts, isTransientGhError);
}

/** As `ghRetry`, but a not-found answer is final (see `isTransientNetGhError`). */
export function ghRetryNet(args: string[], attempts = 5): string {
  return ghRetryWith(args, attempts, isTransientNetGhError);
}

/**
 * Is `next` an acceptable event count to replace an archived month's `prev`? Equal-or-greater
 * always is; a shrink is benign churn only up to 0.5% of `prev` (rounded up, min 1 event).
 * Lives here rather than in archive.ts because that module runs `main()` at import time and so
 * can't be unit-tested — and this is the guard that would have blocked the 2026-07 truncations.
 */
export const withinShrinkTolerance = (prev: number, next: number): boolean => next >= prev - Math.max(1, Math.ceil(prev * 0.005));
