import type { IncomingMessage, OutgoingHttpHeaders, Server } from 'node:http';

import { createServer } from 'node:http';

import type { Config } from './config.ts';
import type { Source } from './origin.ts';
import type { Rendered } from './render.ts';

import { LRU } from './lru.ts';
import { createOrigin } from './origin.ts';
import { negotiateFormat, render } from './render.ts';
import { parseRoute } from './route.ts';
import { verifyImageVariant } from './sign.ts';
import { parseImageTransforms, renderTokens, variantOf } from './transforms.ts';

interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Buffer;
}

/**
 * The HTTP server answering `GET` and `HEAD` on `/{signature}/{transforms}/{path}`.
 *
 * A request is verified by signature before anything is parsed, then checked against `config.variants`.
 * An `unsigned` config skips the signature and renders whatever the first segment holds.
 * A URL whose `e` token has passed is `403`; one still ahead is cached only for the time it has left.
 * The source is read through `createOrigin`; the render is cached under `renderTokens`, format, and ETag.
 * Only a URL with `e` reads it through the signed link, so one that never expires cannot open a private file.
 * Every response carries `Access-Control-Allow-Origin: *` and `Content-Length`.
 * `HEAD` sends the headers of the `GET` and no body.
 * A failure is one plain-text line under `Cache-Control: no-store`.
 *
 * @example
 * ```ts
 * createImageServer(readConfig(process.env)).listen(9100)
 * ```
 */
export function createImageServer(config: Config): Server {
  const variants = new LRU<Rendered>(config.cacheBytes);
  const origin = createOrigin(config);

  async function answer(req: IncomingMessage): Promise<Answer> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    const route = parseRoute(req.url ?? '/');
    if (route === undefined) return fail(404, 'Not found');
    const { signature, transforms, path } = route;
    if (!config.unsigned && !verifyImageVariant(signature, transforms, path, config.secrets)) {
      return fail(403, 'Bad signature');
    }
    if (config.variants && !config.variants.has(variantOf(transforms))) {
      return fail(403, 'Unlisted variant');
    }
    const parsed = parseImageTransforms(transforms);
    if (parsed === undefined) return fail(400, 'Invalid transforms');
    if (parsed.expires !== undefined && parsed.expires <= Date.now()) {
      return fail(403, 'Link expired');
    }
    const variant = `${renderTokens(transforms)}/${path}`;
    let source: Source | undefined;
    try {
      source = await origin(path, parsed.expires !== undefined);
    } catch {
      return fail(502, 'Source unreachable');
    }
    if (source === undefined) return fail(404, 'Not found');
    const format = negotiateFormat(parsed.format, req.headers.accept ?? '');
    const key = `${variant}|${format ?? ''}|${source.etag}`;
    let rendered = variants.get(key);
    if (rendered === undefined) {
      try {
        rendered = await render(source.bytes, parsed, format);
      } catch {
        return fail(500, 'Render failed');
      }
      variants.set(key, rendered);
    }
    const headers: OutgoingHttpHeaders = {
      'Content-Type': `image/${rendered.format}`,
      'Cache-Control': cacheControl(parsed.expires),
    };
    if (parsed.format === 'auto') headers.Vary = 'Accept';
    return { status: 200, headers, body: rendered.bytes };
  }

  return createServer(async (req, res) => {
    const { status, headers, body } = await answer(req);
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Content-Length'] = body.byteLength;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

/**
 * A failure answer: one plain-text line, never cached.
 */
function fail(status: number, line: string, headers: OutgoingHttpHeaders = {}): Answer {
  return {
    status,
    headers: {
      ...headers,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: Buffer.from(`${line}\n`),
  };
}

/**
 * A year in public, or in private for the whole seconds left until `expires`.
 */
function cacheControl(expires: number | undefined): string {
  if (expires === undefined) return 'public, max-age=31536000';
  return `private, max-age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}`;
}
