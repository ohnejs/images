import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { before, describe, it } from 'node:test';
import sharp from 'sharp';

import { negotiateFormat, plan, render } from '../src/render.ts';
import { fixtures, greys, near, pixel, size } from './_fixtures.ts';

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];

describe('plan', () => {
  it('scales one axis and never enlarges at dpr 1', () => {
    deepStrictEqual(plan(600, 400, { width: 300 }, false).size, [300, 200]);
    deepStrictEqual(plan(600, 400, { width: 2000 }, false).size, [600, 400]);
  });

  it('multiplies the box by dpr and enlarges when asked', () => {
    deepStrictEqual(plan(600, 400, { width: 1000, dpr: 2 }, true).size, [2000, 1333]);
  });

  it('shrinks a cover box at its own ratio until the source fills it', () => {
    const geometry = plan(600, 400, { width: 800, height: 800 }, false);
    deepStrictEqual(geometry.size, [400, 400]);
    deepStrictEqual(geometry.crop, { left: 100, top: 0, width: 400, height: 400 });
  });

  it('centres a cover crop on the focal point or the position, clamped inside the source', () => {
    const box = { width: 200, height: 100 };
    const focal = plan(800, 800, { ...box, focalPoint: { x: 0.5, y: 0.75 } }, false);
    deepStrictEqual(focal.crop, { left: 0, top: 400, width: 800, height: 400 });
    strictEqual(plan(800, 800, { ...box, focalPoint: { x: 0, y: 0 } }, false).crop?.top, 0);
    strictEqual(plan(800, 800, { ...box, position: 'bottom' }, false).crop?.top, 400);
  });

  it('fits inside without a canvas and contains with one', () => {
    const inside = plan(600, 400, { width: 300, height: 300, fit: 'inside' }, false);
    deepStrictEqual(inside.size, [300, 200]);
    strictEqual(inside.canvas, undefined);
    const contain = plan(600, 400, { width: 300, height: 300, fit: 'contain' }, false);
    deepStrictEqual(contain.size, [300, 200]);
    deepStrictEqual(contain.canvas, [300, 300]);
    const padded = plan(600, 400, { width: 800, height: 800, fit: 'contain' }, false);
    deepStrictEqual(padded.size, [600, 400]);
    deepStrictEqual(padded.canvas, [800, 800]);
  });

  it('enlarges a vector source', () => {
    deepStrictEqual(plan(64, 64, { width: 512 }, true), { scale: 8, size: [512, 512] });
  });

  it('throws past the output pixel limit', () => {
    throws(() => plan(600, 400, { width: 20000, height: 20000, dpr: 4 }, true), {
      message: 'Output exceeds the pixel limit',
    });
  });
});

describe('negotiateFormat', () => {
  it('resolves auto from Accept and leaves everything else alone', () => {
    strictEqual(negotiateFormat(undefined, 'image/avif'), undefined);
    strictEqual(negotiateFormat('webp', ''), 'webp');
    strictEqual(negotiateFormat('auto', 'image/avif,image/webp'), 'avif');
    strictEqual(negotiateFormat('auto', 'image/webp,*/*'), 'webp');
    strictEqual(negotiateFormat('auto', 'image/*'), undefined);
    strictEqual(negotiateFormat('auto', '*/*'), undefined);
    strictEqual(negotiateFormat('auto', ''), undefined);
  });
});

describe('render', () => {
  let files: Map<string, Buffer>;
  const file = (name: string): Buffer => files.get(name)!;

  before(async () => {
    files = await fixtures();
  });

  it('never enlarges at dpr 1 and multiplies by dpr', async () => {
    const capped = await render(file('photo.jpg'), { width: 2000 }, undefined);
    deepStrictEqual(await size(capped.bytes), { width: 600, height: 400, format: 'jpeg' });
    const doubled = await render(file('photo.jpg'), { width: 1000, dpr: 2 }, undefined);
    deepStrictEqual(await size(doubled.bytes), { width: 2000, height: 1333, format: 'jpeg' });
    const covered = await render(file('photo.jpg'), { width: 800, height: 800 }, undefined);
    deepStrictEqual(await size(covered.bytes), { width: 400, height: 400, format: 'jpeg' });
  });

  it('pads contain to the full box, transparent or white for jpeg', async () => {
    const box = { width: 300, height: 300, fit: 'contain' } as const;
    const png = await render(file('photo.png'), box, 'png');
    deepStrictEqual(await size(png.bytes), { width: 300, height: 300, format: 'png' });
    strictEqual((await pixel(png.bytes, 0, 0))[3], 0);
    strictEqual((await pixel(png.bytes, 150, 150))[3], 255);
    const jpeg = await render(file('photo.png'), box, 'jpeg');
    ok(near(await pixel(jpeg.bytes, 0, 0), WHITE));
  });

  it('flattens alpha onto white for jpeg', async () => {
    const { bytes } = await render(file('alpha.png'), {}, 'jpeg');
    ok(near(await pixel(bytes, 50, 50), WHITE));
  });

  it('crops cover around the focal point or the position', async () => {
    const focal = await render(
      file('focal.png'),
      { width: 200, height: 100, focalPoint: { x: 0.5, y: 0.75 } },
      undefined,
    );
    ok(near(await pixel(focal.bytes, 100, 50), RED));
    const tall = await render(
      file('focal.png'),
      { width: 100, height: 200, focalPoint: { x: 0.25, y: 0.5 } },
      undefined,
    );
    ok(near(await pixel(tall.bytes, 50, 100), GREEN));
    const centred = await render(file('focal.png'), { width: 200, height: 100 }, undefined);
    ok(near(await pixel(centred.bytes, 100, 50), BLUE));
    const bottom = await render(
      file('focal.png'),
      { width: 200, height: 100, position: 'bottom' },
      undefined,
    );
    ok(near(await pixel(bottom.bytes, 100, 50), RED));
  });

  it('applies EXIF orientation and strips the metadata', async () => {
    const { bytes } = await render(file('rotated.jpg'), { width: 100 }, undefined);
    deepStrictEqual(await size(bytes), { width: 100, height: 200, format: 'jpeg' });
    ok(near(await pixel(bytes, 95, 5), RED));
    const meta = await sharp(bytes).metadata();
    strictEqual(meta.orientation, undefined);
    strictEqual(meta.exif, undefined);
  });

  it('rasterizes an SVG as png at the density the output needs', async () => {
    const { bytes, format } = await render(file('stripes.svg'), { width: 512 }, undefined);
    strictEqual(format, 'png');
    deepStrictEqual(await size(bytes), { width: 512, height: 512, format: 'png' });
    strictEqual(await greys(bytes, 5), 0);
    const cropped = await render(
      file('stripes.svg'),
      { width: 512, height: 256, focalPoint: { x: 0, y: 0.5 } },
      undefined,
    );
    deepStrictEqual(await size(cropped.bytes), { width: 512, height: 256, format: 'png' });
  });

  it('keeps the source format without f and encodes the one asked for', async () => {
    const kept = await render(file('photo.jpg'), { width: 10 }, undefined);
    strictEqual(kept.format, 'jpeg');
    const avif = await render(file('photo.jpg'), { width: 10 }, 'avif');
    strictEqual(avif.format, 'avif');
    strictEqual((await size(avif.bytes)).format, 'heif');
  });

  it('quantizes a png at the given quality', async () => {
    const lossless = await render(file('photo.png'), {}, 'png');
    const quantized = await render(file('photo.png'), { quality: 50 }, 'png');
    ok(quantized.bytes.byteLength < lossless.bytes.byteLength);
  });

  it('rejects undecodable bytes, an empty buffer included', async () => {
    await rejects(render(file('broken.png'), { width: 10 }, undefined));
    await rejects(render(Buffer.alloc(0), { width: 10 }, undefined));
  });
});
