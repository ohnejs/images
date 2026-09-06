import { hash } from 'node:crypto';

import type { Config } from './config.ts';

import { LRU } from './lru.ts';

/**
 * A source file as the origin last answered it.
 */
export interface Source {
  /**
   * The file's bytes.
   */
  bytes: Buffer;

  /**
   * The origin's `ETag` verbatim, or the quoted base64url SHA-256 of the bytes when it sent none.
   * Either way a replaced file changes it, and every variant key carries it.
   */
  etag: string;

  /**
   * When the origin last confirmed the bytes, as `Date.now()`.
   */
  fetchedAt: number;
}

/**
 * The most bytes fetched for one source; a longer body rejects mid-stream.
 */
const SOURCE_LIMIT = 64 * 1024 * 1024;

/**
 * Milliseconds one origin fetch may take before it is aborted.
 */
const SOURCE_TIMEOUT = 10_000;

/**
 * A reader of source files under `config.source`, cached per path and revalidated after `config.sourceTTL`.
 *
 * `get(path)` resolves the cached `Source` while it is younger than the TTL and touches no network.
 * Past it, one fetch per path runs with `If-None-Match`; concurrent callers await the same promise.
 * A `304` renews the entry, a `200` replaces it, and a `404` drops it and resolves `undefined`.
 * Another status, a refused connection, a timeout, or a body past `limit` rejects.
 * A rejection keeps the stale entry, so an origin outage evicts nothing; the server answers `502`.
 *
 * @example
 * ```ts
 * const origin = createOrigin(config)
 *
 * await origin('photos/sunset.jpg') // -> { bytes: <Buffer ...>, etag: '"5f2a"', fetchedAt: 1717000000000 }
 * await origin('missing.jpg')       // -> undefined
 * ```
 */
export function createOrigin(
  config: Config,
  limit = SOURCE_LIMIT,
): (path: string) => Promise<Source | undefined> {
  const sources = new LRU<Source>(config.cacheBytes);
  const inflight = new Map<string, Promise<Source | undefined>>();

  async function revalidate(path: string, stale: Source | undefined): Promise<Source | undefined> {
    const response = await fetch(`${config.source}/${path}`, {
      headers: stale ? { 'If-None-Match': stale.etag } : {},
      signal: AbortSignal.timeout(SOURCE_TIMEOUT),
    });
    if (response.ok) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > limit) throw new Error(`Source exceeds ${limit} bytes`);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const etag = response.headers.get('etag') ?? `"${hash('sha256', bytes, 'base64url')}"`;
      const source = { bytes, etag, fetchedAt: Date.now() };
      sources.set(path, source);
      return source;
    }
    // An unread body would pin its connection until it is collected.
    await response.body?.cancel();
    if (response.status === 304 && stale) {
      stale.fetchedAt = Date.now();
      return stale;
    }
    if (response.status === 404) {
      sources.delete(path);
      return undefined;
    }
    throw new Error(`Source answered ${response.status}`);
  }

  return (path) => {
    const cached = sources.get(path);
    if (cached && Date.now() - cached.fetchedAt < config.sourceTTL) return Promise.resolve(cached);
    let pending = inflight.get(path);
    if (pending === undefined) {
      pending = revalidate(path, cached).finally(() => inflight.delete(path));
      inflight.set(path, pending);
    }
    return pending;
  };
}
