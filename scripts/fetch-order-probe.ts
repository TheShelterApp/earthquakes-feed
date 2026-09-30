/**
 * Fetch-order probe (PF-5c): why does a provider's fetch latency on the GitHub runner grow with
 * its place in aggregate's fetch order? Run it on a runner (a throwaway workflow; each job is a
 * fresh VM, so its first pass sees a cold resolver cache, like every aggregate run does).
 *
 *   npx tsx scripts/fetch-order-probe.ts lookup   # getaddrinfo (dns.lookup, libuv threadpool)
 *   npx tsx scripts/fetch-order-probe.ts cares    # c-ares (dns.Resolver, no threadpool)
 *   npx tsx scripts/fetch-order-probe.ts fetch    # the 41 live fetches, lookups timed
 *   npx tsx scripts/fetch-order-probe.ts fetch --warm   # the same after warming the resolver
 *
 * Run each under the default pool and under UV_THREADPOOL_SIZE=64. The `lookup` and `cares`
 * modes send no HTTP request; `fetch` sends each live source one request (ComCat and EMSC one
 * each), never the sweeps.
 */
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { activeProviders, fetchProvider, loadRegistry } from '../src/providers.js';

const mode = process.argv[2] ?? 'lookup';
const warm = process.argv.includes('--warm');
const pool = process.env.UV_THREADPOOL_SIZE ?? '4 (default)';

const hostOf = (url: string): string => new URL(url).hostname;
const all = loadRegistry();
const live = activeProviders(all).filter((p) => p.liveActive !== false);
/** aggregate's fetch order before PF-5c: the live fetches, then the two updatedafter sweeps and
 *  the delete sweep (each a fetch of its own, so each needs its own lookup). */
const order: { label: string; host: string }[] = [
  ...live.map((p) => ({ label: p.id, host: hostOf(p.base) })),
  { label: 'usgs:updated', host: hostOf(all.find((p) => p.id === 'usgs')!.base) },
  { label: 'emsc:updated', host: hostOf(all.find((p) => p.id === 'emsc')!.base) },
  { label: 'usgs:deleted', host: hostOf(all.find((p) => p.id === 'usgs')!.base) },
];

function env(): void {
  let resolv = '';
  try {
    resolv = readFileSync('/etc/resolv.conf', 'utf8')
      .split('\n')
      .filter((l) => /^(nameserver|options|search)/.test(l))
      .join(' | ');
  } catch {
    resolv = '(no /etc/resolv.conf)';
  }
  console.log(`probe mode=${mode}${warm ? ' warm' : ''} node=${process.version} UV_THREADPOOL_SIZE=${pool} resolv.conf: ${resolv}`);
}

const pct = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
};

function table(title: string, rows: { label: string; host: string; ms: number; extra?: string }[]): void {
  console.log(`\n${title}`);
  rows.forEach((r, i) => console.log(`${String(i).padStart(2)} ${r.label.padEnd(13)} ${String(Math.round(r.ms)).padStart(6)} ms  ${r.host}${r.extra ? `  ${r.extra}` : ''}`));
  const ms = rows.map((r) => r.ms);
  const band = (a: number, b: number): string => {
    const xs = ms.slice(a, b + 1);
    return xs.length ? String(Math.round(pct(xs, 0.5))) : '-';
  };
  console.log(`median by place: 0-3 ${band(0, 3)} | 4-12 ${band(4, 12)} | 13-26 ${band(13, 26)} | 27-39 ${band(27, 39)} | 40-42 ${band(40, 42)} ms; max ${Math.round(Math.max(...ms))} ms`);
}

async function lookupAll(label: string, concurrent: boolean): Promise<void> {
  const t0 = performance.now();
  const one = async (host: string): Promise<number> => {
    const s = performance.now();
    await dns.promises.lookup(host, { all: true });
    return performance.now() - (concurrent ? t0 : s);
  };
  const ms: number[] = [];
  if (concurrent) ms.push(...(await Promise.all(order.map((o) => one(o.host)))));
  else for (const o of order) ms.push(await one(o.host));
  table(`${label} (${concurrent ? 'all issued at once, ms from issue' : 'one at a time, ms per lookup'}), total ${Math.round(performance.now() - t0)} ms`, order.map((o, i) => ({ ...o, ms: ms[i]! })));
}

async function caresAll(label: string): Promise<void> {
  const r = new dns.promises.Resolver();
  const t0 = performance.now();
  const ms = await Promise.all(
    order.map(async (o) => {
      await Promise.allSettled([r.resolve4(o.host), r.resolve6(o.host)]);
      return performance.now() - t0;
    }),
  );
  table(`${label} (c-ares A+AAAA, all issued at once), total ${Math.round(performance.now() - t0)} ms`, order.map((o, i) => ({ ...o, ms: ms[i]! })));
}

async function fetchAll(): Promise<void> {
  // Time every getaddrinfo the fetches make (undici connects through dns.lookup).
  const lookups: { host: string; issued: number; done: number }[] = [];
  const orig = dns.lookup;
  const t0 = performance.now();
  (dns as { lookup: unknown }).lookup = function (host: string, opts: unknown, cb: unknown) {
    const rec = { host, issued: performance.now() - t0, done: NaN };
    lookups.push(rec);
    const done = typeof opts === 'function' ? (opts as (...a: unknown[]) => void) : (cb as (...a: unknown[]) => void);
    const wrapped = (...a: unknown[]): void => {
      rec.done = performance.now() - t0;
      done(...a);
    };
    return typeof opts === 'function' ? orig.call(dns, host, wrapped as never) : orig.call(dns, host, opts as never, wrapped as never);
  };
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const nowMs = Date.now();
  const outcomes = await Promise.all(live.map((p) => fetchProvider(p, nowMs)));
  loop.disable();
  (dns as { lookup: unknown }).lookup = orig;
  const firstLookup = new Map<string, { issued: number; done: number }>();
  for (const l of lookups) if (!firstLookup.has(l.host)) firstLookup.set(l.host, l);
  table(
    `fetch${warm ? ' (resolver warmed first)' : ''}: latency_ms as status.json records it; lookup = ms from t0 to that host's first getaddrinfo callback`,
    live.map((p, i) => {
      const o = outcomes[i]!;
      const l = firstLookup.get(hostOf(p.base));
      return {
        label: p.id,
        host: hostOf(p.base),
        ms: o.status.latency_ms ?? NaN,
        extra: `lookup ${l ? `${Math.round(l.issued)}→${Math.round(l.done)}` : '-'}${o.status.ok ? '' : `  FAIL ${o.status.error}`}`,
      };
    }),
  );
  const svc = lookups.filter((l) => Number.isFinite(l.done)).map((l) => l.done - l.issued);
  console.log(
    `lookups ${lookups.length}: issue→callback median ${Math.round(pct(svc, 0.5))} ms, max ${Math.round(Math.max(...svc))} ms; ` +
      `event-loop delay p99 ${Math.round(loop.percentile(99) / 1e6)} ms, max ${Math.round(loop.max / 1e6)} ms`,
  );
}

env();
if (mode === 'lookup') {
  await lookupAll('getaddrinfo, cold', true);
  await lookupAll('getaddrinfo, warm', true);
  await lookupAll('getaddrinfo, warm', false);
} else if (mode === 'cares') {
  await caresAll('c-ares, cold');
  await caresAll('c-ares, warm');
} else if (mode === 'fetch') {
  if (warm) for (const o of order) await dns.promises.lookup(o.host, { all: true }).catch(() => undefined);
  await fetchAll();
} else {
  throw new Error(`unknown mode ${mode}`);
}
