import sharp from 'sharp';

import type { ImageFormat, ImagePosition, ImageTransforms } from './transforms.ts';

/**
 * What the service encodes.
 * `gif` is only ever kept from a `gif` source; no `f` token asks for it.
 */
export type OutputFormat = 'webp' | 'avif' | 'jpeg' | 'png' | 'gif';

/**
 * The most pixels an output may have, the same bound sharp puts on its input.
 */
const MAX_OUTPUT_PIXELS = 0x3fff * 0x3fff;

/**
 * The fitting plan for one source.
 */
export interface Geometry {
  /**
   * The factor from source pixels to output pixels.
   */
  scale: number;

  /**
   * The resized image in pixels; omitted, the source is re-encoded as it is.
   */
  size?: [number, number];

  /**
   * The source window a `cover` fit keeps, in source pixels.
   */
  crop?: {
    /**
     * The window's left edge.
     */
    left: number;

    /**
     * The window's top edge.
     */
    top: number;

    /**
     * The window's width.
     */
    width: number;

    /**
     * The window's height.
     */
    height: number;
  };

  /**
   * The full box a `contain` fit pads the image to, in pixels.
   */
  canvas?: [number, number];
}

/**
 * A rendered variant.
 */
export interface Rendered {
  /**
   * The encoded bytes.
   */
  bytes: Buffer;

  /**
   * The format the bytes are encoded in, which names the `Content-Type`.
   */
  format: OutputFormat;
}

const POSITIONS: Record<ImagePosition, readonly [number, number]> = {
  center: [0.5, 0.5],
  top: [0.5, 0],
  topRight: [1, 0],
  right: [1, 0.5],
  bottomRight: [1, 1],
  bottom: [0.5, 1],
  bottomLeft: [0, 1],
  left: [0, 0.5],
  topLeft: [0, 0],
};

const SOURCE_FORMATS: Partial<Record<string, OutputFormat>> = {
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  heif: 'avif',
};

/**
 * The format to encode, given the `f` token and the request's `Accept` header.
 *
 * `undefined` stays `undefined`, meaning the source format, which `render` resolves once it has decoded.
 * `auto` is `avif` when `Accept` names `image/avif`, else `webp` when it names `image/webp`.
 * Otherwise `auto` is the source format too.
 * Any other token is itself.
 * Pure, so the server builds a cache key before any byte is decoded.
 *
 * @example
 * ```ts
 * negotiateFormat('auto', 'image/avif,image/webp,*\/*') // -> 'avif'
 * negotiateFormat('auto', 'image/webp,*\/*')            // -> 'webp'
 * negotiateFormat('auto', '*\/*')                       // -> undefined
 * negotiateFormat('png', 'image/avif')                  // -> 'png'
 * ```
 */
export function negotiateFormat(
  format: ImageFormat | undefined,
  accept: string,
): OutputFormat | undefined {
  if (format !== 'auto') return format;
  if (accept.includes('image/avif')) return 'avif';
  if (accept.includes('image/webp')) return 'webp';
  return undefined;
}

/**
 * The geometry one render needs: the dpr-multiplied box fitted to a `width` by `height` source.
 *
 * `enlarge` false caps every scale at `1`, so `inside` and `contain` never grow the image.
 * `cover` shrinks the box at its own ratio until the source fills it, then crops around the focal point.
 * `contain` keeps the full box as `canvas`; padding is not enlargement.
 * An output past `MAX_OUTPUT_PIXELS` throws before any pixel is touched.
 *
 * @example
 * ```ts
 * plan(600, 400, { width: 300 }, false)
 * // -> { scale: 0.5, size: [300, 200] }
 *
 * plan(600, 400, { width: 800, height: 800 }, false)
 * // -> { scale: 1, size: [400, 400], crop: { left: 100, top: 0, width: 400, height: 400 } }
 * ```
 */
export function plan(
  width: number,
  height: number,
  transforms: ImageTransforms,
  enlarge: boolean,
): Geometry {
  const dpr = transforms.dpr ?? 1;
  const boxWidth = transforms.width ? Math.round(transforms.width * dpr) : 0;
  const boxHeight = transforms.height ? Math.round(transforms.height * dpr) : 0;
  const fit = boxWidth && boxHeight ? (transforms.fit ?? 'cover') : undefined;
  let geometry: Geometry = { scale: 1 };
  if (fit === 'cover') {
    geometry = cover(width, height, boxWidth, boxHeight, transforms, enlarge);
  } else if (boxWidth || boxHeight) {
    const scale = Math.min(
      boxWidth ? boxWidth / width : Infinity,
      boxHeight ? boxHeight / height : Infinity,
      enlarge ? Infinity : 1,
    );
    geometry = { scale, size: [px(width * scale), px(height * scale)] };
    if (fit === 'contain') geometry.canvas = [boxWidth, boxHeight];
  }
  const [outputWidth, outputHeight] = geometry.canvas ?? geometry.size ?? [width, height];
  if (outputWidth * outputHeight > MAX_OUTPUT_PIXELS)
    throw new Error('Output exceeds the pixel limit');
  return geometry;
}

/**
 * Renders `bytes` under `transforms` into `format`, or into the source's own format when it is omitted.
 *
 * A vector source is rasterized at the density the output needs, so its edges stay crisp at any size.
 * EXIF orientation is applied first and every tag is stripped from the output.
 * A `jpeg` output is flattened onto white; a `contain` pad is white for `jpeg`, transparent otherwise.
 * `quality` sets the encoder; on `png` it switches to palette quantization.
 * Undecodable bytes, an output past `MAX_OUTPUT_PIXELS`, and an encoder failure all reject.
 *
 * @example
 * ```ts
 * await render(jpegBytes, { width: 300 }, undefined) // -> { bytes: <Buffer ...>, format: 'jpeg' }
 * await render(svgBytes, { width: 512 }, undefined)  // -> { bytes: <Buffer ...>, format: 'png' }
 * await render(pngBytes, { quality: 50 }, 'webp')    // -> { bytes: <Buffer ...>, format: 'webp' }
 * ```
 */
export async function render(
  bytes: Buffer,
  transforms: ImageTransforms,
  format: OutputFormat | undefined,
): Promise<Rendered> {
  const meta = await sharp(bytes).metadata();
  let { width, height } = meta.autoOrient;
  const vector = meta.format === 'svg';
  const output = format ?? SOURCE_FORMATS[meta.format] ?? 'png';
  let geometry = plan(width, height, transforms, vector || (transforms.dpr ?? 1) > 1);
  let density: number | undefined;
  if (vector && geometry.size) {
    density = Math.min(100_000, Math.max(1, (meta.density ?? 72) * geometry.scale));
    ({ width, height } = await sharp(bytes, { density }).metadata());
    geometry = plan(width, height, transforms, true);
  }
  let image = sharp(bytes, { autoOrient: true, density });
  if (geometry.crop) image = image.extract(geometry.crop);
  if (geometry.size) {
    const [w, h] = geometry.size;
    image = image.resize(w, h, { fit: 'fill' });
    if (geometry.canvas) {
      const [canvasWidth, canvasHeight] = geometry.canvas;
      const left = Math.floor((canvasWidth - w) / 2);
      const top = Math.floor((canvasHeight - h) / 2);
      // libvips flattens before it extends, so a jpeg pad has to be painted white here.
      const background = output === 'jpeg' ? '#ffffff' : { r: 0, g: 0, b: 0, alpha: 0 };
      image = image.extend({
        left,
        top,
        right: canvasWidth - w - left,
        bottom: canvasHeight - h - top,
        background,
      });
    }
  }
  if (output === 'jpeg') image = image.flatten({ background: '#ffffff' });
  const encoded = await image.toFormat(output, { quality: transforms.quality }).toBuffer();
  return { bytes: encoded, format: output };
}

/**
 * The `cover` geometry: the box shrunk at its own ratio until the source fills it.
 * The crop window is centred on the focal point, or on the position, and clamped inside the source.
 */
function cover(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
  transforms: ImageTransforms,
  enlarge: boolean,
): Geometry {
  const shrink = enlarge ? 1 : Math.min(1, width / boxWidth, height / boxHeight);
  const size: [number, number] = [px(boxWidth * shrink), px(boxHeight * shrink)];
  const scale = Math.max(size[0] / width, size[1] / height);
  const cropWidth = Math.min(width, px(size[0] / scale));
  const cropHeight = Math.min(height, px(size[1] / scale));
  const [fx, fy] = transforms.focalPoint
    ? [transforms.focalPoint.x, transforms.focalPoint.y]
    : POSITIONS[transforms.position ?? 'center'];
  return {
    scale,
    size,
    crop: {
      left: clamp(Math.round(fx * width - cropWidth / 2), 0, width - cropWidth),
      top: clamp(Math.round(fy * height - cropHeight / 2), 0, height - cropHeight),
      width: cropWidth,
      height: cropHeight,
    },
  };
}

/**
 * A pixel count: `n` rounded, and at least `1`.
 */
function px(n: number): number {
  return Math.max(1, Math.round(n));
}

/**
 * `n` held within `min` and `max`.
 */
function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
