const SEGMENT = /^(?!\.\.?$)[a-z0-9._-]+$/;

/**
 * The three parts of a variant URL's path.
 */
export interface Route {
  /**
   * The first segment, the signature as it was sent.
   */
  signature: string;

  /**
   * The second segment, the token string as it was signed.
   * `''` when the segment is empty; the server answers that `400` once the signature has verified.
   */
  transforms: string;

  /**
   * The remaining segments joined, the source path fetched from the origin.
   */
  path: string;
}

/**
 * Splits a request URL into signature, transforms, and source path, or `undefined` when it cannot.
 *
 * The query string is dropped first, so it never reaches routing or a cache key.
 * Fewer than three segments is no route.
 * A path segment is lowercase letters, digits, `.`, `_`, or `-`, and neither `.` nor `..`.
 * Nothing is percent-decoded, so a returned path names only `{source}/{path}` inside the origin.
 *
 * @example
 * ```ts
 * parseRoute('/sig/w_800/photos/sunset.jpg?v=2')
 * // -> { signature: 'sig', transforms: 'w_800', path: 'photos/sunset.jpg' }
 *
 * parseRoute('/sig/w_800/../sunset.jpg')
 * // -> undefined
 * ```
 */
export function parseRoute(url: string): Route | undefined {
  const [, signature, transforms, ...rest] = url.split('?', 1)[0].split('/');
  if (rest.length === 0 || !rest.every((segment) => SEGMENT.test(segment))) return undefined;
  return { signature, transforms, path: rest.join('/') };
}
