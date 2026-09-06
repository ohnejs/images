import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import { parseRoute } from '../src/route.ts';

describe('parseRoute', () => {
  it('splits signature, transforms, and path, dropping the query', () => {
    const route = { signature: 'sig', transforms: 'w_800', path: 'photos/2024/sunset.jpg' };
    deepStrictEqual(parseRoute('/sig/w_800/photos/2024/sunset.jpg?v=2'), route);
    deepStrictEqual(parseRoute('/sig/w_800/photos/2024/sunset.jpg'), route);
  });

  it('keeps an empty transforms segment for the server to refuse', () => {
    deepStrictEqual(parseRoute('/sig//a.jpg'), { signature: 'sig', transforms: '', path: 'a.jpg' });
  });

  it('is undefined for too few segments and for any segment outside the slug alphabet', () => {
    for (const url of [
      '/',
      '/a',
      '/a/b',
      '/a/b/',
      '/a/b//c',
      '/a/b/../c',
      '/a/b/./c',
      '/a/b/Photo.jpg',
      '/a/b/%2e%2e/c',
      '/a/b/c:d',
    ]) {
      strictEqual(parseRoute(url), undefined, url);
    }
  });
});
