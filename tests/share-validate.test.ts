import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeDetailHours } from '../src/event-detail.js';
import { pagesHeaders } from '../src/pages-headers.js';
import { SHARE_DIR, SHARE_NOT_FOUND, SHARE_PAGE_CAP, writeSharePages } from '../src/share-pages.js';
import type { EventNode } from '../src/types.js';
import { deterministicFeedId } from '../src/ulid.js';

// validate.ts (the deploy gate) on the share-link products: the detail files' `moved` contract and the share pages.

const NOW = Date.now();
const HOUR = 3_600_000;

function ev(timeMs: number, lat: number, over: Partial<EventNode> = {}): EventNode {
  const id = deterministicFeedId(timeMs, lat, 120);
  return {
    feedId: id,
    aliases: [],
    eventTimeMs: timeMs,
    firstIngestTime: new Date(timeMs + 60_000).toISOString(),
    lastIngestTime: new Date(timeMs + 60_000).toISOString(),
    lat,
    lon: 120,
    depth: 10,
    mag: 5.1,
    magType: 'mb',
    status: 'reviewed',
    place: 'Luzon, Philippines',
    chosenProvider: 'usgs',
    provenance: [{ provider: 'usgs', nativeId: id, eventTimeMs: timeMs, mag: 5.1, magType: 'mb', status: 'reviewed', providerUpdatedMs: null, lat, lon: 120, depth: 10, place: 'Luzon, Philippines', chosen: true, license: 'US-PD', attribution: 'USGS', doi: null, fields: {} }],
    revision: 1,
    firstSeenSeq: 1,
    lastSeq: 1,
    state: 'live',
    geohash: 'x',
    ...over,
  };
}

function fixture(): { pub: string; data: string; live: EventNode; retired: EventNode; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'share-validate-'));
  const pub = join(root, 'public');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  const hourStart = Math.floor((NOW - 3 * HOUR) / HOUR) * HOUR;
  const live = ev(hourStart + 20 * 60_000, 10);
  const retired = ev(hourStart + 19 * 60_000, 11, { state: 'superseded', supersededBy: live.feedId });
  const days = [new Date(NOW - 86_400_000).toISOString().slice(0, 10), new Date(NOW).toISOString().slice(0, 10)];
  writeDetailHours([live, retired], days, { publicV1: join(pub, 'v1'), nowMs: NOW });
  writeSharePages([live, retired], { publicDir: pub, window: { startMs: Date.parse(`${days[0]}T00:00:00Z`), endMs: NOW + 600_000 } });
  writeFileSync(join(pub, '_headers'), pagesHeaders(NOW, days));
  return { pub, data, live, retired, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function validate(pub: string, data: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/validate.ts'], { env: { ...process.env, PUBLIC_DIR: pub, DATA_DIR: data }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('validate passes the share pages and the moved members derive writes', () => {
  const f = fixture();
  try {
    const r = validate(f.pub, f.data);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /2 share page\(s\), cap 5000/);
  } finally {
    f.cleanup();
  }
});

test('validate warns on share-page and moved content problems and still passes: a share page never stops the feed', () => {
  const f = fixture();
  try {
    const dir = join(f.pub, SHARE_DIR);
    const page = join(dir, `${f.live.feedId}.html`);
    writeFileSync(page, readFileSync(page, 'utf8').replace('</body>', '<script>alert(1)</script></body>'));
    writeFileSync(join(dir, 'hello.html'), readFileSync(join(dir, `${f.retired.feedId}.html`)));
    rmSync(join(dir, SHARE_NOT_FOUND));
    const hour = new Date(Math.floor(f.retired.eventTimeMs / HOUR) * HOUR).toISOString().slice(0, 13);
    const file = join(f.pub, 'v1', 'detail', `${hour}.geojson`);
    const fc = JSON.parse(readFileSync(file, 'utf8')) as { moved: Record<string, { to: string; hour: string }> };
    fc.moved[f.retired.feedId]!.to = 'efd_00000000000000000000000000';
    writeFileSync(file, JSON.stringify(fc));
    const r = validate(f.pub, f.data);
    assert.equal(r.code, 0, r.out);
    for (const msg of [
      /::warning::share: efd_\w+\.html holds a script/,
      /::warning::share: hello\.html is not named by a feed id/,
      /::warning::share: share\/event\/404\.html is missing/,
      /::warning::detail [\dT-]+: moved efd_\w+ points at efd_0{26}, which is not in the hour/,
    ]) {
      assert.match(r.out, msg);
    }
  } finally {
    f.cleanup();
  }
});

test('validate fails a CSP without the stylesheet hash and more pages than the cap', () => {
  const f = fixture();
  try {
    const headers = join(f.pub, '_headers');
    writeFileSync(headers, readFileSync(headers, 'utf8').replace(/style-src 'sha256-[^']+'/, "style-src 'unsafe-inline'"));
    const dir = join(f.pub, SHARE_DIR);
    const body = readFileSync(join(dir, `${f.live.feedId}.html`));
    for (let i = 0; i < SHARE_PAGE_CAP; i++) writeFileSync(join(dir, `${deterministicFeedId(NOW - 7 * 86_400_000 + i * 60_000, 0, 0)}.html`), body);
    const r = validate(f.pub, f.data);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ share: _headers serves \/share\/\* without the CSP/);
    assert.match(r.out, new RegExp(`✗ share: ${SHARE_PAGE_CAP + 2} pages, over the cap of ${SHARE_PAGE_CAP}`));
  } finally {
    f.cleanup();
  }
});
