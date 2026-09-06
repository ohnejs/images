import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import type { FixtureOrigin } from './_fixtures.ts';

import { createOrigin } from '../src/origin.ts';
import { fixtures, serveFixtures, testConfig } from './_fixtures.ts';

describe('createOrigin', () => {
  let files: Map<string, Buffer>;
  let origin: FixtureOrigin;

  before(async () => {
    files = await fixtures();
    origin = await serveFixtures(files);
  });

  after(() => origin.close());

  it('serves from memory while the source is younger than the TTL', async () => {
    const { ok: before } = origin.hits;
    const get = createOrigin(testConfig(origin.url, { sourceTTL: 60_000 }));
    const first = await get('photo.jpg');
    const second = await get('photo.jpg');
    strictEqual(origin.hits.ok - before, 1);
    strictEqual(second, first);
  });

  it('revalidates a stale source with If-None-Match', async () => {
    const { notModified } = origin.hits;
    const get = createOrigin(testConfig(origin.url));
    const first = await get('photo.jpg');
    const second = await get('photo.jpg');
    strictEqual(origin.hits.notModified - notModified, 1);
    ok(first && second);
    strictEqual(second.etag, first.etag);
    ok(second.bytes.equals(first.bytes));
  });

  it('replaces a source whose ETag changed', async () => {
    const original = files.get('photo.png')!;
    const get = createOrigin(testConfig(origin.url));
    const first = await get('photo.png');
    const { ok: before } = origin.hits;
    files.set('photo.png', files.get('photo.jpg')!);
    const second = await get('photo.png');
    files.set('photo.png', original);
    strictEqual(origin.hits.ok - before, 1);
    ok(first && second);
    ok(second.etag !== first.etag);
  });

  it('hashes the bytes when the origin sends no ETag', async () => {
    const own = new Map([['a.png', files.get('photo.png')!]]);
    const bare = await serveFixtures(own, { etags: false });
    try {
      const get = createOrigin(testConfig(bare.url));
      const first = await get('a.png');
      const second = await get('a.png');
      ok(first && second);
      ok(/^"[A-Za-z0-9_-]{43}"$/.test(first.etag), first.etag);
      strictEqual(second.etag, first.etag);
      deepStrictEqual(bare.hits, { ok: 2, notModified: 0, notFound: 0 });
      own.set('a.png', files.get('photo.jpg')!);
      const third = await get('a.png');
      ok(third && third.etag !== first.etag);
    } finally {
      bare.close();
    }
  });

  it('resolves undefined for a missing file and drops one that vanished', async () => {
    const own = new Map([['a.png', files.get('photo.png')!]]);
    const server = await serveFixtures(own);
    try {
      const get = createOrigin(testConfig(server.url));
      strictEqual(await get('missing.jpg'), undefined);
      strictEqual(server.hits.notFound, 1);
      ok(await get('a.png'));
      own.delete('a.png');
      strictEqual(await get('a.png'), undefined);
    } finally {
      server.close();
    }
  });

  it('shares one fetch between concurrent misses', async () => {
    const { ok: before } = origin.hits;
    const get = createOrigin(testConfig(origin.url));
    const sources = await Promise.all(Array.from({ length: 10 }, () => get('focal.png')));
    strictEqual(origin.hits.ok - before, 1);
    ok(sources.every((source) => source === sources[0]));
  });

  it('rejects when the origin is unreachable', async () => {
    const get = createOrigin(testConfig('http://127.0.0.1:1/uploads'));
    await rejects(get('photo.jpg'));
  });

  it('rejects a body past the limit', async () => {
    const get = createOrigin(testConfig(origin.url), 100);
    await rejects(get('photo.jpg'), { message: 'Source exceeds 100 bytes' });
  });

  it('rejects any other origin failure', async () => {
    const get = createOrigin(testConfig(origin.url));
    await rejects(get('error.jpg'), { message: 'Source answered 500' });
  });
});
