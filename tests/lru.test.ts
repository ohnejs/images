import { notStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import { LRU } from '../src/lru.ts';

function entry(bytes: number): { bytes: Buffer } {
  return { bytes: Buffer.alloc(bytes) };
}

describe('LRU', () => {
  it('evicts the oldest entry once the budget is exceeded', () => {
    const cache = new LRU<{ bytes: Buffer }>(10);
    cache.set('a', entry(4));
    cache.set('b', entry(4));
    cache.set('c', entry(4));
    strictEqual(cache.get('a'), undefined);
    notStrictEqual(cache.get('b'), undefined);
    notStrictEqual(cache.get('c'), undefined);
  });

  it('counts a get as use', () => {
    const cache = new LRU<{ bytes: Buffer }>(10);
    cache.set('a', entry(4));
    cache.set('b', entry(4));
    cache.get('a');
    cache.set('c', entry(4));
    strictEqual(cache.get('b'), undefined);
    notStrictEqual(cache.get('a'), undefined);
  });

  it('does not retain a value larger than the budget', () => {
    const cache = new LRU<{ bytes: Buffer }>(10);
    cache.set('a', entry(12));
    strictEqual(cache.get('a'), undefined);
  });

  it('subtracts the replaced bytes on a repeated set', () => {
    const cache = new LRU<{ bytes: Buffer }>(10);
    cache.set('a', entry(6));
    cache.set('a', entry(6));
    cache.set('b', entry(4));
    notStrictEqual(cache.get('a'), undefined);
    notStrictEqual(cache.get('b'), undefined);
  });

  it('frees the bytes of a deleted entry', () => {
    const cache = new LRU<{ bytes: Buffer }>(10);
    cache.set('a', entry(6));
    cache.delete('a');
    cache.set('b', entry(6));
    cache.set('c', entry(4));
    notStrictEqual(cache.get('b'), undefined);
    notStrictEqual(cache.get('c'), undefined);
  });
});
