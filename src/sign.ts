import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signs a variant: base64url HMAC-SHA256 over `{transforms}/{path}` under `secret`.
 * The signed string is the raw one the service receives, so it verifies before it parses.
 *
 * @example
 * ```ts
 * signImageVariant('w_800,f_webp', 'photos/sunset.jpg', 'secret')
 * // -> '2ObrtBfM78cHtN36wuvyNQXgSGGcr4cZtUQeqAhJyck'
 * ```
 */
export function signImageVariant(transforms: string, path: string, secret: string): string {
  return createHmac('sha256', secret).update(`${transforms}/${path}`).digest('base64url');
}

/**
 * Whether `signature` is the signature of the variant under any of `secrets`.
 * Each candidate is compared in constant time, so the duration never reveals where they first differ.
 * `''`, a wrong length, and an empty `secrets` list are `false`; nothing throws.
 *
 * @example
 * ```ts
 * const signature = signImageVariant('w_800', 'a.jpg', 'old')
 *
 * verifyImageVariant(signature, 'w_800', 'a.jpg', ['new', 'old']) // -> true
 * verifyImageVariant(signature, 'w_800', 'a.jpg', ['new'])        // -> false
 * ```
 */
export function verifyImageVariant(
  signature: string,
  transforms: string,
  path: string,
  secrets: readonly string[],
): boolean {
  const given = Buffer.from(signature);
  return secrets.some((secret) => {
    const expected = Buffer.from(signImageVariant(transforms, path, secret));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
