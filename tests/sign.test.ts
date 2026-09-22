import { strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import { signImageVariant, verifyImageVariant } from '../src/sign.ts';

describe('signImageVariant', () => {
  it('matches the protocol vectors', () => {
    strictEqual(
      signImageVariant('w_800,f_webp', 'photos/sunset.jpg', 'secret'),
      '2ObrtBfM78cHtN36wuvyNQXgSGGcr4cZtUQeqAhJyck',
    );
    strictEqual(
      signImageVariant('w_320,h_320,fit_inside', 'photos/sunset.jpg', 'another'),
      's9YxH4SXC6gGsS97gs_WMTAcNvgSnZe7zUBB__NeUMs',
    );
    strictEqual(
      signImageVariant('w_800,f_webp,e_1700000000000', 'photos/sunset.jpg', 'secret'),
      'lznJAVjMklhx4zqJ2JblQECAwz3_EDRvDnho4upa-YA',
    );
    strictEqual(
      signImageVariant('e_1700000000000', 'photos/sunset.jpg', 'secret'),
      'lbshLgROalNk_URHWIraK7YDalfVmPq9WlenM8B9Ytg',
    );
  });
});

describe('verifyImageVariant', () => {
  const signature = signImageVariant('w_800', 'a.jpg', 'old');

  it('accepts a signature under any listed secret', () => {
    strictEqual(verifyImageVariant(signature, 'w_800', 'a.jpg', ['new', 'old']), true);
    strictEqual(verifyImageVariant(signature, 'w_800', 'a.jpg', ['new']), false);
  });

  it('rejects everything else without throwing', () => {
    strictEqual(verifyImageVariant('', 'w_800', 'a.jpg', ['old']), false);
    strictEqual(verifyImageVariant('short', 'w_800', 'a.jpg', ['old']), false);
    strictEqual(verifyImageVariant(signature, 'w_801', 'a.jpg', ['old']), false);
    strictEqual(verifyImageVariant(signature, 'w_800', 'b.jpg', ['old']), false);
    strictEqual(verifyImageVariant(signature, 'w_800', 'a.jpg', []), false);
  });
});
