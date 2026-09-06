# ohne-images

The reference image service for the [ohne](https://github.com/murisceman/ohne) uploads image
protocol, on Node and sharp. ohne signs a variant URL; this service verifies the signature, fetches
the source from your app's `/uploads` origin, renders the variant, and caches the result.

## Run

```sh
pnpm install
node bin.js --unsigned
```

That is the local setup. Every URL renders without a signature check, and sources come from
`http://localhost:9001/uploads`, ohne's default API port. Start ohne without `IMAGES_SECRET` and it
writes `unsigned` where the signature would go. Keep an unsigned instance on your own machine; it
renders for anyone who can reach it.

Anywhere others can reach, share a secret with ohne and name the source origin:

```sh
node bin.js --secret secret --source http://localhost:9002/uploads
```

It prints one line once it listens:

```
ohne-images ready at http://localhost:9100
```

To render only the variants your app names, list their token strings. `imageVariantTokens()` in ohne
answers them:

```sh
node bin.js --secret secret --variants 'w_320,h_320,fit_inside,f_webp;w_640,h_360,f_webp'
```

## Configuration

Every setting is a flag and an environment variable, and the flag wins. `--help` lists them.

| flag           | variable            | default                         | meaning                                                                                           |
| -------------- | ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `--port`       | `PORT`              | `9100`                          | The port to listen on.                                                                            |
| `--host`       | `HOST`              | unset                           | The address to bind. Unset binds every interface.                                                 |
| `--secret`     | `IMAGES_SECRET`     | required unless unsigned        | Comma-separated secrets. A URL signed by any of them is accepted, which is how you rotate.        |
| `--source`     | `IMAGES_SOURCE`     | `http://localhost:9001/uploads` | The origin a source path is fetched from.                                                         |
| `--variants`   | `IMAGES_VARIANTS`   | unset                           | Semicolon-separated token strings. When set, a verified URL whose tokens are not listed is `403`. |
| `--source-ttl` | `IMAGES_SOURCE_TTL` | `60`                            | Seconds a fetched source is trusted before it is revalidated with `If-None-Match`.                |
| `--cache-mb`   | `IMAGES_CACHE_MB`   | `256`                           | Megabytes of rendered variants kept in memory. The source bytes get the same budget.              |
| `--unsigned`   | `IMAGES_UNSIGNED`   | off                             | Render every URL with no signature check. For your own machine only.                              |

The `IMAGES_VARIANTS` match ignores `fp` and `p`, which carry an upload's focal point rather than a
size. An invalid or missing required value prints one line to stderr and exits with `1`.

## What it does

The protocol is ohne's
[image variants guide](https://github.com/murisceman/ohne/blob/main/docs/uploads/images.md). A
request for `/{signature}/{transforms}/{path}` goes through six steps.

1. **Route.** The first segment is the signature, the second the transforms, the rest the source
   path. Fewer than three segments, or a path segment that is not lowercase letters, digits, `.`,
   `_`, and `-`, is `404`. The query string is ignored, for routing and for the cache.
2. **Verify.** The signature is the base64url HMAC-SHA256 of the raw `{transforms}/{path}` string.
   It is checked in constant time against every secret before anything is parsed; a mismatch is
   `403`. Unsigned, the segment is not looked at. With `IMAGES_VARIANTS` set, tokens outside the
   list are `403` too.
3. **Parse.** An empty transforms segment, an unknown token, an out-of-range value, a duplicate, or
   both `p` and `fp` is `400`.
4. **Fetch.** The source comes from `{IMAGES_SOURCE}/{path}` and stays in memory. After
   `IMAGES_SOURCE_TTL` the next request revalidates it with `If-None-Match`; a new `ETag` drops
   every variant of the file, and an origin that sends no `ETag` gets a hash of the bytes instead. An
   origin `404` is `404`, an unreachable origin `502`, both `Cache-Control: no-store`.
5. **Render.** `w` and `h` are multiplied by `dpr` before fitting. At `dpr` 1 nothing is enlarged:
   `inside` and `contain` keep the source size, `cover` shrinks the box at its own ratio until the
   source fills it. `contain` pads to the full box, transparent or white for `jpeg`. `p` and `fp`
   position a `cover` crop only. EXIF orientation is applied and the metadata stripped. Without `f`
   the source format is kept, `png` for an SVG; `f_auto` picks `avif`, then `webp`, then the source
   format from `Accept` and adds `Vary: Accept`. An SVG is rasterized at the density the output
   needs. A render that fails is `500`.
6. **Answer.** The bytes go out with `Content-Type`, `Content-Length`,
   `Cache-Control: public, max-age=31536000`, and `Access-Control-Allow-Origin: *`, and stay cached
   in memory for the next request. `HEAD` gets the same headers and no body. Any other method is
   `405`.

## Limits

- A source is fetched up to 64 MiB, and one fetch may take 10 seconds.
- Decode and output are each bounded by 268,402,689 pixels, the same bound sharp puts on its input.
- Animated input renders its first frame.
- `Accept` is matched by substring; `q` values are not weighed.
- Caches live in memory, hold at most two `IMAGES_CACHE_MB` budgets, and vanish on restart. Put a
  CDN in front for a durable layer.
- An SVG without a `viewBox` may render from its ink bounds, so give an uploaded SVG one.
