import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { FixtureOrigin } from './_fixtures.ts';

import { createOrigin } from '../src/origin.ts';
import { fixtures, listen, serveFixtures, testConfig } from './_fixtures.ts';

const ahead = Date.now() + 3_600_000;

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
      deepStrictEqual(bare.hits, { ok: 2, notModified: 0, notFound: 0, refused: 0 });
      own.set('a.png', files.get('photo.jpg')!);
      const third = await get('a.png');
      ok(third && third.etag !== first.etag);
    } finally {
      bare.close();
    }
  });

  it('signs a fetch under the first secret when asked to', async () => {
    const own = new Map([['a.png', files.get('photo.png')!]]);
    const secured = await serveFixtures(own, { sourceSecret: 'uploads' });
    try {
      const get = createOrigin(testConfig(secured.url, { secrets: ['uploads', 'other'] }));
      const first = await get('a.png', ahead);
      const second = await get('a.png', ahead);
      ok(first && second);
      strictEqual(second.etag, first.etag);
      deepStrictEqual(secured.hits, { ok: 1, notModified: 1, notFound: 0, refused: 0 });
      strictEqual(await get('a.png'), undefined);
      for (const secrets of [[], ['other']]) {
        const plain = createOrigin(testConfig(secured.url, { secrets }));
        strictEqual(await plain('a.png', ahead), undefined);
      }
      strictEqual(secured.hits.refused, 3);
    } finally {
      secured.close();
    }
  });

  it('signs the fetch with the expiry it was asked for', async () => {
    const requested: string[] = [];
    const server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.writeHead(404);
      res.end();
    });
    const url = await listen(server);
    try {
      const get = createOrigin(testConfig(url, { secrets: ['uploads'] }));
      await get('a.png', ahead);
      strictEqual(new URL(requested[0], url).searchParams.get('e'), String(ahead));
    } finally {
      server.close();
    }
  });

  it('signs under the first secret only, never a later one', async () => {
    const own = new Map([['a.png', files.get('photo.png')!]]);
    const secured = await serveFixtures(own, { sourceSecret: 'uploads' });
    try {
      const get = createOrigin(testConfig(secured.url, { secrets: ['new', 'uploads'] }));
      strictEqual(await get('a.png', ahead), undefined);
      deepStrictEqual(secured.hits, { ok: 0, notModified: 0, notFound: 0, refused: 1 });
    } finally {
      secured.close();
    }
  });

  it('caches a signed source apart from a bare one', async () => {
    const own = new Map([['a.png', files.get('photo.png')!]]);
    const secured = await serveFixtures(own, { sourceSecret: 'uploads' });
    try {
      const get = createOrigin(
        testConfig(secured.url, { secrets: ['uploads'], sourceTTL: 60_000 }),
      );
      ok(await get('a.png', ahead));
      strictEqual(await get('a.png'), undefined);
      ok(await get('a.png', ahead));
      deepStrictEqual(secured.hits, { ok: 1, notModified: 0, notFound: 0, refused: 1 });
    } finally {
      secured.close();
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
