/**
 * How an image is fitted into a requested box.
 * `cover` fills the box and crops, `contain` letterboxes, `inside` shrinks to fit without padding.
 */
export type ImageFit = 'cover' | 'contain' | 'inside';

/**
 * The encoded format of a variant.
 * `auto` lets the service pick from the request's `Accept` header.
 */
export type ImageFormat = 'webp' | 'avif' | 'jpeg' | 'png' | 'auto';

/**
 * Where a `cover` crop keeps its subject when no focal point is given.
 */
export type ImagePosition =
  | 'center'
  | 'top'
  | 'topRight'
  | 'right'
  | 'bottomRight'
  | 'bottom'
  | 'bottomLeft'
  | 'left'
  | 'topLeft';

/**
 * The transforms an image variant URL asks the image service for.
 * Every field is optional; the canonical token string omits defaults, so one variant has one URL.
 */
export interface ImageTransforms {
  /**
   * The target width in pixels, a positive integer.
   */
  width?: number;

  /**
   * The target height in pixels, a positive integer.
   */
  height?: number;

  /**
   * How the image fits the box.
   *
   * @default
   * 'cover'
   */
  fit?: ImageFit;

  /**
   * The output format.
   * Omitted, the service keeps the source format.
   */
  format?: ImageFormat;

  /**
   * The encoding quality, `1` to `100`.
   * Omitted, the service applies its own default.
   */
  quality?: number;

  /**
   * Where a crop keeps its subject.
   * A `focalPoint` takes precedence.
   *
   * @default
   * 'center'
   */
  position?: ImagePosition;

  /**
   * The point a crop keeps in view, each axis `0` to `1`, rounded to three decimals.
   */
  focalPoint?: {
    /**
     * The horizontal position, `0` at the left edge.
     */
    x: number;

    /**
     * The vertical position, `0` at the top edge.
     */
    y: number;
  };

  /**
   * The device pixel ratio the target size is multiplied by, `1` to `4`.
   *
   * @default
   * 1
   */
  dpr?: number;
}

const FITS: readonly ImageFit[] = ['cover', 'contain', 'inside'];

const FORMATS: readonly ImageFormat[] = ['webp', 'avif', 'jpeg', 'png', 'auto'];

const POSITIONS: readonly ImagePosition[] = [
  'center',
  'top',
  'topRight',
  'right',
  'bottomRight',
  'bottom',
  'bottomLeft',
  'left',
  'topLeft',
];

const TOKEN = /^([a-z]+)_(.+)$/;

const FOCAL = /^(\d(?:\.\d{1,3})?)_(\d(?:\.\d{1,3})?)$/;

/**
 * Parses a token string into transforms, or `undefined` when it is not valid.
 *
 * Every token must be known, well-formed, in range, and unique; `p` and `fp` exclude each other.
 * Order is not enforced, so a string is parsed exactly as it was signed.
 * `''` is not valid: a variant asks for something, and the service answers `400` to an empty segment.
 *
 * @example
 * ```ts
 * parseImageTransforms('w_800,f_webp') // -> { width: 800, format: 'webp' }
 * parseImageTransforms('fp_0.25_1')    // -> { focalPoint: { x: 0.25, y: 1 } }
 * parseImageTransforms('w_800,w_600')  // -> undefined
 * parseImageTransforms('')             // -> undefined
 * ```
 */
export function parseImageTransforms(tokens: string): ImageTransforms | undefined {
  if (tokens === '') return undefined;
  const transforms: ImageTransforms = {};
  const seen = new Set<string>();
  for (const token of tokens.split(',')) {
    const match = TOKEN.exec(token);
    if (match === null || seen.has(match[1])) return undefined;
    seen.add(match[1]);
    if (!parseToken(transforms, match[1], match[2])) return undefined;
  }
  if (seen.has('p') && seen.has('fp')) return undefined;
  return transforms;
}

/**
 * The identity the allowlist compares: the tokens with `p` and `fp` removed.
 * They carry the upload's focal point rather than a size, so one variant has many spellings of them.
 *
 * @example
 * ```ts
 * variantOf('w_320,h_320,fit_inside,f_webp,fp_0.5_0.75') // -> 'w_320,h_320,fit_inside,f_webp'
 * variantOf('w_64,p_top,dpr_2')                          // -> 'w_64,dpr_2'
 * variantOf('fp_0_0')                                    // -> ''
 * ```
 */
export function variantOf(tokens: string): string {
  return tokens
    .split(',')
    .filter((token) => !/^f?p_/.test(token))
    .join(',');
}

/**
 * Applies one parsed token to `transforms`, reporting whether it was valid.
 */
function parseToken(transforms: ImageTransforms, name: string, value: string): boolean {
  switch (name) {
    case 'w':
    case 'h': {
      if (!/^[1-9]\d*$/.test(value)) return false;
      transforms[name === 'w' ? 'width' : 'height'] = Number(value);
      return true;
    }
    case 'fit':
      return assign(transforms, 'fit', value, FITS);
    case 'f':
      return assign(transforms, 'format', value, FORMATS);
    case 'p':
      return assign(transforms, 'position', value, POSITIONS);
    case 'q': {
      if (!/^(?:[1-9]\d?|100)$/.test(value)) return false;
      transforms.quality = Number(value);
      return true;
    }
    case 'fp': {
      const focal = FOCAL.exec(value);
      if (focal === null) return false;
      const x = Number(focal[1]);
      const y = Number(focal[2]);
      if (x > 1 || y > 1 || String(x) !== focal[1] || String(y) !== focal[2]) return false;
      transforms.focalPoint = { x, y };
      return true;
    }
    case 'dpr': {
      const ratio = Number(value);
      if (!/^\d(?:\.\d{1,2})?$/.test(value) || ratio < 1 || ratio > 4 || String(ratio) !== value) {
        return false;
      }
      transforms.dpr = ratio;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Sets an enumerated transform when `value` is one of `allowed`.
 */
function assign<K extends 'fit' | 'format' | 'position'>(
  transforms: ImageTransforms,
  key: K,
  value: string,
  allowed: readonly NonNullable<ImageTransforms[K]>[],
): boolean {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) return false;
  transforms[key] = found;
  return true;
}
