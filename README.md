# @ohnejs/images

The reference image service for [ohne](https://ohne.dev) uploads, on Node and sharp. ohne gives an
uploaded image a signed URL for each [variant](https://ohne.dev/docs/uploads/image-variants), a
resized, cropped, or re-encoded copy. This service checks the signature, fetches the original from
your app, renders the copy, and caches it.

## Install

You need Node 26 or newer. Run it straight from npm:

```sh
npx @ohnejs/images --unsigned
```

Or add it to your project and run its `ohne-images` command:

```sh
pnpm add @ohnejs/images
pnpm exec ohne-images --unsigned
```

## Running it locally

`--unsigned` skips the signature check, and originals come from `http://localhost:9001/uploads`,
where `ohne dev` serves them. Run ohne without `UPLOADS_SECRET` and the two work together with no
secret. An unsigned service renders for anyone who can reach it, so keep it on your own machine.

## Connecting ohne

Point `uploads.images.url` at the service, as in
[Connecting a service](https://ohne.dev/docs/uploads/image-variants#connecting-a-service):

```ts
// ohne.config.ts
import { defineConfig } from 'ohnejs';

export default defineConfig({
  layers: ['ohnejs/base', 'ohnejs/uploads'],
  uploads: {
    images: { url: 'http://localhost:9100' },
  },
});
```

Then give the service your app's `UPLOADS_SECRET` as its `IMAGES_SECRET`, so it renders only URLs
ohne signed:

```sh
IMAGES_SECRET=a-long-random-value npx @ohnejs/images
```

The service fetches each original from your app's `/uploads` route, `http://localhost:9001/uploads`
by default. Elsewhere, pass `--source https://api.example.com/uploads`.

## Allowing only your variants

By default the service renders any size ohne signs. `--variants` narrows it to your app's variants,
as token strings separated by semicolons. A token string is the
[transforms](https://ohne.dev/docs/uploads/image-service#transforms) part of a variant URL, and
`imageVariantTokens()` returns one per variant:

```ts
import { imageVariantTokens } from 'ohnejs/uploads';

Object.values(imageVariantTokens()).join(';');
// -> 'w_320,h_320,fit_inside,f_webp;w_640,h_360,f_webp'
```

```sh
IMAGES_SECRET=a-long-random-value npx @ohnejs/images \
  --variants 'w_320,h_320,fit_inside,f_webp;w_640,h_360,f_webp'
```

Any other URL gets a `403`. See
[Allowing only your variants](https://ohne.dev/docs/uploads/image-variants#allowing-only-your-variants).

## Private files

A [private file's](https://ohne.dev/docs/uploads/private-files) original answers `404` to a plain
fetch. The service fetches it through a link it signs with its own secret, which your app checks
against `UPLOADS_SECRET`. The link expires with the variant URL, so your app's `uploads.linkMaxAge`
caps it too. With that value as `IMAGES_SECRET`, as above, nothing else is needed. An unsigned
instance has no secret, so it cannot open a private original.

## Configuration

Every setting is a flag and an environment variable, and the flag wins. `--help` lists them.

| flag           | variable            | default                         | meaning                                                                                   |
| -------------- | ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `--port`       | `PORT`              | `9100`                          | The port to listen on.                                                                    |
| `--host`       | `HOST`              | unset                           | The address to bind. Unset binds every interface.                                         |
| `--secret`     | `IMAGES_SECRET`     | required unless unsigned        | Comma-separated secrets. A URL signed by any is accepted; the first opens private files.  |
| `--source`     | `IMAGES_SOURCE`     | `http://localhost:9001/uploads` | The `http` or `https` origin originals are fetched from.                                  |
| `--variants`   | `IMAGES_VARIANTS`   | unset                           | Semicolon-separated token strings. Unset renders every signed URL.                        |
| `--source-ttl` | `IMAGES_SOURCE_TTL` | `60`                            | Seconds a fetched original is trusted before it is checked again.                         |
| `--cache-mb`   | `IMAGES_CACHE_MB`   | `256`                           | MiB of rendered variants kept in memory. Fetched originals get a budget of the same size. |
| `--unsigned`   | `IMAGES_UNSIGNED`   | off                             | Render every URL with no signature check. For your own machine only.                      |

## What it does

The service follows ohne's [image service protocol](https://ohne.dev/docs/uploads/image-service).
Where the protocol leaves room, this is what it does:

- A path segment is lowercase letters, digits, `.`, `_`, and `-`. Anything else, and a `.` or `..`
  segment, is `404`.
- Without `f`, JPEG, PNG, WebP, and GIF keep their format. HEIF and AVIF become `avif`. SVG and
  every other format become `png`.
- A raster original is enlarged only when `dpr` is above `1`. An SVG is enlarged at any `dpr`,
  rasterized at the density the output needs.
- A render is cached for a year, `Cache-Control: public, max-age=31536000`.

## Deploying

Run it as one process under a process manager or in a container. Its caches live in memory and
empty on restart, so put a CDN in front for a durable layer.

To change `IMAGES_SECRET` without breaking pages, follow
[Rotating the secret](https://ohne.dev/docs/uploads/image-variants#rotating-the-secret). The
service lists them the same way ohne does: the first signs, any verifies.

## Limits

- An original is fetched up to 64 MiB, and one fetch may take 10 seconds.
- Decode and output are each bounded by 268,402,689 pixels, the same bound sharp puts on its input.
- Animated input renders its first frame.
- `Accept` is matched by substring; `q` values are not weighed.
- The caches hold at most two `--cache-mb` budgets, one for renders and one for originals.
- An SVG without a `viewBox` may render from its ink bounds, so give an uploaded SVG one.

## Contributing

From a clone, run `pnpm install`, then `node bin.js --unsigned`.
