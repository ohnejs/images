import type { IncomingMessage, Server } from 'node:http';

import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { get } from 'node:http';
import { after, before, describe, it, mock } from 'node:test';
import sharp from 'sharp';

import type { FixtureOrigin } from './_fixtures.ts';

import { LRU } from '../src/lru.ts';
import { createImageServer } from '../src/server.ts';
import { variantOf } from '../src/transforms.ts';
import {
  fixtures,
  greys,
  listen,
  near,
  pixel,
  serveFixtures,
  size,
  testConfig,
  variantURL,
} from './_fixtures.ts';

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];

async function request(url: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

/**
 * A `GET` that sends `path` as written, where `fetch` would resolve its dot segments first.
 */
async function rawGet(base: string, path: string): Promise<Answer> {
  const response = await new Promise<IncomingMessage>((resolve) => get(base, { path }, resolve));
  return {
    status: response.statusCode ?? 0,
    headers: response.headers as Record<string, string>,
    body: Buffer.concat(await response.toArray()),
  };
}

function failure(answer: Answer, status: number, line: string): void {
  strictEqual(answer.status, status);
  strictEqual(answer.body.toString(), `${line}\n`);
  strictEqual(answer.headers['content-type'], 'text/plain; charset=utf-8');
  strictEqual(answer.headers['cache-control'], 'no-store');
  strictEqual(answer.headers['access-control-allow-origin'], '*');
}

describe('createImageServer', () => {
  let files: Map<string, Buffer>;
  let origin: FixtureOrigin;
  const servers: Server[] = [];
  let base: string;
  let listed: string;
  let open: string;
  let down: string;

  const url = (transforms: string, path: string, secret?: string): string =>
    variantURL(base, transforms, path, secret);

  async function start(source: string, overrides = {}): Promise<string> {
    const server = createImageServer(
      testConfig(source, { secrets: ['test', 'old'], ...overrides }),
    );
    servers.push(server);
    return listen(server);
  }

  before(async () => {
    files = await fixtures();
    origin = await serveFixtures(files);
    base = await start(origin.url);
    const variants = [
      'w_320,h_320,fit_inside,f_webp',
      'w_64,h_64,f_png',
      'w_640,h_360,f_webp,p_top',
    ];
    listed = await start(origin.url, { variants: new Set(variants.map(variantOf)) });
    open = await start(origin.url, { unsigned: true, secrets: [] });
    down = await start('http://127.0.0.1:1/uploads');
  });

  after(() => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    origin.close();
  });

  it('renders a signed variant with long caching and CORS', async () => {
    const answer = await request(url('w_300,f_webp', 'photo.jpg'));
    strictEqual(answer.status, 200);
    strictEqual(answer.headers['content-type'], 'image/webp');
    strictEqual(answer.headers['cache-control'], 'public, max-age=31536000');
    strictEqual(answer.headers['access-control-allow-origin'], '*');
    strictEqual(Number(answer.headers['content-length']), answer.body.byteLength);
    strictEqual(answer.headers.vary, undefined);
    deepStrictEqual(await size(answer.body), { width: 300, height: 200, format: 'webp' });
  });

  it('answers 403 to a signature that does not verify, before parsing', async () => {
    const good = variantURL(base, 'w_300', 'photo.jpg').split('/')[3];
    for (const target of [
      url('w_300', 'photo.jpg', 'wrong'),
      `${base}/${good}/w_301/photo.jpg`,
      `${base}/${good}/w_300/other.jpg`,
      `${base}/nonsense/rotate_90/photo.jpg`,
      `${base}/unsigned/w_300/photo.jpg`,
    ]) {
      failure(await request(target), 403, 'Bad signature');
    }
  });

  it('renders every URL when unsigned, whatever the first segment holds', async () => {
    for (const signature of ['unsigned', 'nonsense']) {
      const answer = await request(`${open}/${signature}/w_300,f_webp/photo.jpg`);
      strictEqual(answer.status, 200);
      deepStrictEqual(await size(answer.body), { width: 300, height: 200, format: 'webp' });
    }
    failure(await request(`${open}/unsigned/rotate_90/photo.jpg`), 400, 'Invalid transforms');
  });

  it('answers 404 to a URL that is no route and to a missing source', async () => {
    for (const target of [
      `${base}/`,
      `${base}/photo.jpg`,
      `${base}/sig/w_1`,
      url('w_100', 'Photo.jpg'),
    ]) {
      failure(await request(target), 404, 'Not found');
    }
    for (const path of ['../photo.jpg', './photo.jpg']) {
      const dots = url('w_100', path).slice(base.length);
      failure(await rawGet(base, dots), 404, 'Not found');
    }
    const { notFound } = origin.hits;
    failure(await request(url('w_100', 'missing.jpg')), 404, 'Not found');
    strictEqual(origin.hits.notFound - notFound, 1);
  });

  it('answers 400 to transforms that do not parse', async () => {
    for (const transforms of [
      '',
      'rotate_90',
      'w_800,w_600',
      'p_top,fp_0_0',
      'w_08',
      'dpr_5',
      'q_101',
      'fit_fill',
      'f_gif',
    ]) {
      failure(await request(url(transforms, 'photo.jpg')), 400, 'Invalid transforms');
    }
  });

  it('answers 405 with Allow to any other method', async () => {
    for (const method of ['POST', 'PUT']) {
      const answer = await request(url('w_300', 'photo.jpg'), { method });
      failure(answer, 405, 'Method not allowed');
      strictEqual(answer.headers.allow, 'GET, HEAD');
    }
  });

  it('answers HEAD with the headers of the GET and no body', async () => {
    for (const target of [url('w_200,f_webp', 'photo.jpg'), `${base}/photo.jpg`]) {
      const got = await request(target);
      const head = await request(target, { method: 'HEAD' });
      strictEqual(head.status, got.status);
      strictEqual(head.body.byteLength, 0);
      strictEqual(Number(head.headers['content-length']), got.body.byteLength);
      strictEqual(head.headers['access-control-allow-origin'], '*');
      for (const hop of ['date', 'connection', 'keep-alive']) {
        delete got.headers[hop];
        delete head.headers[hop];
      }
      deepStrictEqual(head.headers, got.headers);
    }
  });

  it('accepts a URL signed by any listed secret', async () => {
    strictEqual((await request(url('w_50', 'photo.jpg', 'old'))).status, 200);
    strictEqual((await request(url('w_50', 'photo.jpg', 'new'))).status, 403);
  });

  it('ignores the query string', async () => {
    const plain = await request(url('w_120,f_webp', 'photo.jpg'));
    const queried = await request(`${url('w_120,f_webp', 'photo.jpg')}?v=2`);
    strictEqual(queried.status, 200);
    ok(queried.body.equals(plain.body));
  });

  it('answers 403 to a URL whose expiry has passed', async () => {
    for (const expires of [1, Date.now()]) {
      failure(await request(url(`w_100,e_${expires}`, 'photo.jpg')), 403, 'Link expired');
    }
  });

  it('renders an expiring URL with private caching for the time it has left', async () => {
    const answer = await request(url(`w_100,f_webp,e_${Date.now() + 3_600_000}`, 'photo.jpg'));
    strictEqual(answer.status, 200);
    strictEqual(answer.headers['content-type'], 'image/webp');
    const maxAge = Number(/^private, max-age=(\d+)$/.exec(answer.headers['cache-control'])?.[1]);
    ok(maxAge > 3500 && maxAge <= 3600, answer.headers['cache-control']);
    deepStrictEqual(await size(answer.body), { width: 100, height: 67, format: 'webp' });
  });

  it('opens a private original only for a URL that expires', async () => {
    const own = new Map([['scan.png', files.get('photo.png')!]]);
    const secured = await serveFixtures(own, { sourceSecret: 'uploads' });
    try {
      const at = await start(secured.url, { sourceSecret: 'uploads', sourceTTL: 60_000 });
      const expiring = await request(
        variantURL(at, `w_90,e_${Date.now() + 3_600_000}`, 'scan.png'),
      );
      strictEqual(expiring.status, 200);
      failure(await request(variantURL(at, 'w_90', 'scan.png')), 404, 'Not found');
      strictEqual(secured.hits.refused, 1);
    } finally {
      secured.close();
    }
  });

  it('shares one render between expiry windows', async () => {
    const now = Date.now();
    const set = mock.method(LRU.prototype, 'set');
    try {
      const first = await request(url(`w_130,f_webp,e_${now + 3_600_000}`, 'photo.jpg'));
      const stored = set.mock.callCount();
      const second = await request(url(`w_130,f_webp,e_${now + 7_200_000}`, 'photo.jpg'));
      strictEqual(first.status, 200);
      strictEqual(second.status, 200);
      ok(second.body.equals(first.body));
      ok(stored > 0);
      strictEqual(set.mock.callCount(), stored);
    } finally {
      set.mock.restore();
    }
  });

  it('negotiates f_auto from Accept and varies on it', async () => {
    const target = url('w_100,f_auto', 'photo.jpg');
    const avif = await request(target, { headers: { Accept: 'image/avif,image/webp' } });
    strictEqual(avif.headers['content-type'], 'image/avif');
    strictEqual(avif.headers.vary, 'Accept');
    strictEqual((await size(avif.body)).format, 'heif');
    const webp = await request(target, { headers: { Accept: 'image/webp' } });
    strictEqual(webp.headers['content-type'], 'image/webp');
    const source = await request(target, { headers: { Accept: '*/*' } });
    strictEqual(source.headers['content-type'], 'image/jpeg');
    strictEqual(source.headers.vary, 'Accept');
    const fixed = await request(url('w_100,f_webp', 'photo.jpg'));
    strictEqual(fixed.headers.vary, undefined);
  });

  it('pads contain to the full box', async () => {
    const png = await request(url('w_300,h_300,fit_contain,f_png', 'photo.png'));
    deepStrictEqual(await size(png.body), { width: 300, height: 300, format: 'png' });
    strictEqual((await pixel(png.body, 0, 0))[3], 0);
    const jpeg = await request(url('w_300,h_300,fit_contain,f_jpeg', 'photo.png'));
    ok(near(await pixel(jpeg.body, 0, 0), WHITE));
  });

  it('crops cover around fp and p', async () => {
    const focal = await request(url('w_200,h_100,f_png,fp_0.5_0.75', 'focal.png'));
    ok(near(await pixel(focal.body, 100, 50), RED));
    const tall = await request(url('w_100,h_200,f_png,fp_0.25_0.5', 'focal.png'));
    ok(near(await pixel(tall.body, 50, 100), GREEN));
    const centred = await request(url('w_200,h_100,f_png', 'focal.png'));
    ok(near(await pixel(centred.body, 100, 50), BLUE));
    const bottom = await request(url('w_200,h_100,f_png,p_bottom', 'focal.png'));
    ok(near(await pixel(bottom.body, 100, 50), RED));
  });

  it('never enlarges at dpr 1', async () => {
    const inside = await request(url('w_300,h_300,fit_inside', 'photo.png'));
    deepStrictEqual(await size(inside.body), { width: 300, height: 200, format: 'png' });
    const wide = await request(url('w_2000', 'photo.jpg'));
    deepStrictEqual(await size(wide.body), { width: 600, height: 400, format: 'jpeg' });
    const cover = await request(url('w_800,h_800', 'photo.jpg'));
    deepStrictEqual(await size(cover.body), { width: 400, height: 400, format: 'jpeg' });
  });

  it('multiplies the box by dpr', async () => {
    const { body } = await request(url('w_1000,dpr_2', 'photo.jpg'));
    deepStrictEqual(await size(body), { width: 2000, height: 1333, format: 'jpeg' });
  });

  it('rasterizes an SVG crisply as png', async () => {
    const answer = await request(url('w_512', 'stripes.svg'));
    strictEqual(answer.headers['content-type'], 'image/png');
    strictEqual((await size(answer.body)).width, 512);
    strictEqual(await greys(answer.body, 5), 0);
  });

  it('refuses a verified URL outside IMAGES_VARIANTS', async () => {
    const at = (transforms: string): Promise<Answer> =>
      request(variantURL(listed, transforms, 'focal.png'));
    for (const transforms of [
      'w_320,h_320,fit_inside,f_webp',
      'w_64,h_64,f_png,fp_0.5_0.75',
      'w_64,h_64,f_png,p_bottom',
      'w_640,h_360,f_webp',
      'w_640,h_360,f_webp,fp_0.5_0.75',
    ]) {
      strictEqual((await at(transforms)).status, 200, transforms);
    }
    for (const transforms of [
      'w_321,h_320,fit_inside,f_webp',
      'w_320,h_320,f_webp',
      'fp_0.5_0.75',
    ]) {
      failure(await at(transforms), 403, 'Unlisted variant');
    }
  });

  it('matches the allowlist without the expiry token', async () => {
    const at = (transforms: string): Promise<Answer> =>
      request(variantURL(listed, transforms, 'focal.png'));
    const ahead = Date.now() + 60_000;
    strictEqual((await at(`w_64,h_64,f_png,fp_0.5_0.75,e_${ahead}`)).status, 200);
    failure(await at('w_64,h_64,f_png,e_1'), 403, 'Link expired');
    failure(await at(`w_65,h_64,f_png,e_${ahead}`), 403, 'Unlisted variant');
  });

  it('drops the variants of a replaced source and answers 404 once it is gone', async () => {
    const original = files.get('photo.png')!;
    const target = url('w_1000,f_png', 'photo.png');
    const first = await request(target);
    deepStrictEqual(await size(first.body), { width: 600, height: 400, format: 'png' });
    const { ok: before } = origin.hits;
    files.set('photo.png', await sharp(original).resize(300, 200).png().toBuffer());
    const second = await request(target);
    deepStrictEqual(await size(second.body), { width: 300, height: 200, format: 'png' });
    strictEqual(origin.hits.ok - before, 1);
    files.delete('photo.png');
    failure(await request(target), 404, 'Not found');
    files.set('photo.png', original);
  });

  it('answers 502 when the origin is unreachable', async () => {
    failure(await request(variantURL(down, 'w_100', 'photo.jpg')), 502, 'Source unreachable');
  });

  it('answers 500 when the render fails', async () => {
    failure(await request(url('w_10', 'broken.png')), 500, 'Render failed');
    failure(await request(url('w_20000,h_20000,dpr_4', 'photo.jpg')), 500, 'Render failed');
  });

  it('writes nothing to stderr for a failed fetch or render', async () => {
    const write = mock.method(process.stderr, 'write', () => true);
    try {
      await request(variantURL(down, 'w_100', 'photo.jpg'));
      await request(url('w_10', 'broken.png'));
    } finally {
      write.mock.restore();
    }
    strictEqual(write.mock.callCount(), 0);
  });
});
