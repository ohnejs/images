import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import { parseImageTransforms, variantOf } from '../src/transforms.ts';

describe('parseImageTransforms', () => {
  it('parses every token', () => {
    deepStrictEqual(parseImageTransforms('w_800,h_600,fit_contain,f_webp,q_80,fp_0.3_0.6,dpr_2'), {
      width: 800,
      height: 600,
      fit: 'contain',
      format: 'webp',
      quality: 80,
      focalPoint: { x: 0.3, y: 0.6 },
      dpr: 2,
    });
    deepStrictEqual(parseImageTransforms('w_800,f_webp'), { width: 800, format: 'webp' });
    deepStrictEqual(parseImageTransforms('w_64,p_top'), { width: 64, position: 'top' });
    deepStrictEqual(parseImageTransforms('fp_0.25_1'), { focalPoint: { x: 0.25, y: 1 } });
  });

  it('is undefined for anything that is not a valid token string', () => {
    for (const tokens of [
      '',
      'rotate_90',
      'w_08',
      'w_0',
      'w_',
      'w_800,w_600',
      'p_top,fp_0_0',
      'dpr_5',
      'dpr_0.5',
      'dpr_1.0',
      'q_101',
      'q_0',
      'fit_fill',
      'f_gif',
      'fp_.5_0',
      'fp_1.5_0',
      'fp_0.1234_0',
    ]) {
      strictEqual(parseImageTransforms(tokens), undefined, tokens);
    }
  });
});

describe('variantOf', () => {
  it('drops p and fp and keeps everything else', () => {
    strictEqual(
      variantOf('w_320,h_320,fit_inside,f_webp,fp_0.5_0.75'),
      'w_320,h_320,fit_inside,f_webp',
    );
    strictEqual(variantOf('w_64,p_top,dpr_2'), 'w_64,dpr_2');
    strictEqual(variantOf('fp_0_0'), '');
  });
});
