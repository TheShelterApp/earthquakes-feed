import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

/**
 * The Cloudflare API 2xx set + the S3 metadata we care about. R2 speaks the S3 API, so aws4fetch
 * SigV4-signs every request; we use path-style URLs (`<endpoint>/<bucket>/<key>`) because R2's
 * S3 endpoint is one host per account.
 */
export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface PutObject {
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

export type PutOutcome = 'put' | 'skipped';

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Idempotent R2 writer. Before each PUT it HEADs the object and compares our own `x-amz-meta-sha256`
 * (R2's ETag is an MD5 of the parts, not our identity sha, so we cannot use it): equal ⇒ skip.
 * Every object carries `Access-Control-Allow-Origin: *` for the web audience and the identity sha
 * in metadata so a later run can prove it is unchanged.
 */
export class R2Publisher {
  private readonly aws: AwsClient;
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly cfg: R2Config) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region ?? 'auto', service: 's3' });
    this.base = `${cfg.endpoint.replace(/\/+$/, '')}/${cfg.bucket}`;
    this.doFetch = cfg.fetch ?? fetch;
  }

  private url(key: string): string {
    return `${this.base}/${key.replace(/^\/+/, '')}`;
  }

  /** Current identity sha of the stored object (from our metadata), or null when absent. */
  async headSha(key: string): Promise<string | null> {
    const req = await this.aws.sign(this.url(key), { method: 'HEAD' });
    const res = await this.doFetch(req);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 HEAD ${key} → ${res.status}`);
    return res.headers.get('x-amz-meta-sha256');
  }

  async put(obj: PutObject): Promise<PutOutcome> {
    const sha = sha256Hex(obj.body);
    if ((await this.headSha(obj.key)) === sha) return 'skipped';
    const req = await this.aws.sign(this.url(obj.key), {
      method: 'PUT',
      body: obj.body,
      headers: {
        'Content-Type': obj.contentType,
        'Cache-Control': obj.cacheControl,
        'x-amz-meta-sha256': sha,
        'Access-Control-Allow-Origin': '*',
      },
    });
    const res = await this.doFetch(req);
    if (!res.ok) throw new Error(`R2 PUT ${obj.key} → ${res.status} ${await res.text().catch(() => '')}`);
    return 'put';
  }
}

// --- Cache-Control + Content-Type per artifact class (data-plane spec table) ---

const CC_MANIFEST = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400';
const CC_SUMMARY = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400';
const CC_STATUS = 'public, max-age=0, s-maxage=60, stale-while-revalidate=120, stale-if-error=86400';
const CC_PARTITION_MUTABLE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400';
const CC_IMMUTABLE = 'public, max-age=31536000, immutable';

export function cacheControlFor(key: string, opts: { frozen?: boolean } = {}): string {
  if (key === 'v2/manifest.json' || key === 'v1/manifest.json') return CC_MANIFEST;
  if (key === 'v1/status.json' || key === 'v2/status.json') return CC_STATUS;
  if (key.startsWith('events/') && key.endsWith('.ndjson')) return opts.frozen ? CC_IMMUTABLE : CC_PARTITION_MUTABLE;
  if (key.endsWith('.geojson')) return CC_SUMMARY;
  return CC_MANIFEST;
}

export function contentTypeFor(key: string): string {
  if (key.endsWith('.geojson')) return 'application/geo+json';
  if (key.endsWith('.ndjson')) return 'application/x-ndjson';
  if (key.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
