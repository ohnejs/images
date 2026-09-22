import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Sharp } from 'sharp';

import { hash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import sharp from 'sharp';

import type { Config } from '../src/config.ts';

import { signImageVariant, verifyImageVariant } from '../src/sign.ts';

/**
 * A fixture origin: the files it serves, what it has answered, and how to stop it.
 */
export interface FixtureOrigin {
  /**
   * The `/uploads` base the service fetches from.
   */
  url: string;

  /**
   * How often each branch has answered.
   */
  hits: { ok: number; notModified: number; notFound: number; refused: number };

  /**
   * Stops the server and drops its connections.
   */
  close(): void;
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<rect width="32" height="64" fill="#000"/><rect x="32" width="32" height="64" fill="#fff"/></svg>';

/**
 * The test images, built with sharp so no binary lives in the repo.
 * `focal.png` carries a red square at `fp_0.5_0.75` and a green one at `fp_0.25_0.5`.
 * `rotated.jpg` is stored 200x100 with a red square at its top-left and displays 100x200, red top-right.
 */
export async function fixtures(): Promise<Map<string, Buffer>> {
  const square = (fill: string) => solid(40, 40, fill).png().toBuffer();
  const focal = await solid(800, 800, '#0000ff')
    .composite([
      { input: await square('#ff0000'), left: 380, top: 580 },
      { input: await square('#00ff00'), left: 180, top: 380 },
    ])
    .png()
    .toBuffer();
  const rotated = await solid(200, 100, '#0000ff')
    .composite([{ input: await solid(20, 20, '#ff0000').png().toBuffer(), left: 0, top: 0 }])
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const alpha = await sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  return new Map([
    ['photo.jpg', await solid(600, 400, '#c04030').jpeg().toBuffer()],
    ['photo.png', await solid(600, 400, '#3070c0').png().toBuffer()],
    ['alpha.png', alpha],
    ['focal.png', focal],
    ['rotated.jpg', rotated],
    ['stripes.svg', Buffer.from(SVG)],
    ['broken.png', Buffer.from('not an image')],
  ]);
}

/**
 * Serves `files` under `/uploads/<name>` on a free port, with strong ETags unless `etags` is `false`.
 * A matching `If-None-Match` answers `304`, an unknown name `404`, and `error.jpg` `500`.
 * With `sourceSecret`, every file is private: a fetch is `404`, as ohne answers one, unless its link opens.
 * The link opens when `s` signs `e_<e>/<name>` under `sourceSecret` and `e` is still ahead.
 * The Map is live, so a test can replace or delete a file between requests.
 */
export async function serveFixtures(
  files: Map<string, Buffer>,
  { etags = true, sourceSecret }: { etags?: boolean; sourceSecret?: string } = {},
): Promise<FixtureOrigin> {
  const hits = { ok: 0, notModified: 0, notFound: 0, refused: 0 };
  const server = createServer((req, res) => {
    const [route, query = ''] = (req.url ?? '').split('?', 2);
    const name = route.replace(/^\/uploads\//, '');
    if (sourceSecret !== undefined && !linkOpens(query, name, sourceSecret)) {
      hits.refused += 1;
      res.writeHead(404);
      return res.end();
    }
    if (name === 'error.jpg') {
      res.writeHead(500);
      return res.end();
    }
    const file = files.get(name);
    if (file === undefined) {
      hits.notFound += 1;
      res.writeHead(404);
      return res.end();
    }
    const etag = `"${hash('sha1', file)}"`;
    if (etags && req.headers['if-none-match'] === etag) {
      hits.notModified += 1;
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    hits.ok += 1;
    res.writeHead(200, { 'Content-Length': file.byteLength, ...(etags ? { ETag: etag } : {}) });
    res.end(file);
  });
  const url = `${await listen(server)}/uploads`;
  return {
    url,
    hits,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/**
 * Whether `query` carries an `e` still ahead and an `s` signing `e_<e>/<name>` under `secret`.
 */
function linkOpens(query: string, name: string, secret: string): boolean {
  const params = new URLSearchParams(query);
  const expires = params.get('e') ?? '';
  const signature = params.get('s') ?? '';
  return (
    Number(expires) > Date.now() && verifyImageVariant(signature, `e_${expires}`, name, [secret])
  );
}

/**
 * Starts `server` on a free loopback port and resolves its base URL.
 */
export async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * A `Config` for tests: secret `test`, no allowlist, a TTL of `0` so every request revalidates.
 */
export function testConfig(source: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    secrets: ['test'],
    unsigned: false,
    source,
    sourceSecret: undefined,
    variants: undefined,
    sourceTTL: 0,
    cacheBytes: 64 * 1024 * 1024,
    ...overrides,
  };
}

/**
 * A signed variant URL under `base`.
 */
export function variantURL(
  base: string,
  transforms: string,
  path: string,
  secret = 'test',
): string {
  return `${base}/${signImageVariant(transforms, path, secret)}/${transforms}/${path}`;
}

/**
 * The RGBA of one pixel of an encoded image.
 */
export async function pixel(
  buffer: Buffer,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

/**
 * Whether every channel of `a` is within `tolerance` of `b`.
 */
export function near(a: readonly number[], b: readonly number[], tolerance = 12): boolean {
  return a.every((value, i) => Math.abs(value - b[i]) <= tolerance);
}

/**
 * The decoded dimensions and container format of an encoded image.
 */
export async function size(
  buffer: Buffer,
): Promise<{ width: number; height: number; format: string }> {
  const { width, height, format } = await sharp(buffer).metadata();
  return { width, height, format };
}

/**
 * How many pixels on `row` are neither black nor white, judged by the first channel.
 * A crisp edge between a black and a white half counts `0`; a resampled one counts its blur.
 */
export async function greys(buffer: Buffer, row: number): Promise<number> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let x = 0; x < info.width; x++) {
    const value = data[(row * info.width + x) * info.channels];
    if (value > 20 && value < 235) count += 1;
  }
  return count;
}

/**
 * A solid `fill` image of `width` by `height`, three channels.
 */
function solid(width: number, height: number, fill: string): Sharp {
  return sharp({ create: { width, height, channels: 3, background: fill } });
}
