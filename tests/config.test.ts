import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { describe, it } from 'node:test';

import { parseFlags, readConfig } from '../src/config.ts';

const REQUIRED = { IMAGES_SECRET: 'a' };

const SECRET_REQUIRED =
  '`IMAGES_SECRET` is required unless `--unsigned` is set: comma-separated secrets, a URL signed by any of them is accepted.';

describe('readConfig', () => {
  it('fills the defaults', () => {
    deepStrictEqual(readConfig(REQUIRED), {
      port: 9100,
      host: undefined,
      secrets: ['a'],
      unsigned: false,
      source: 'http://localhost:9001/uploads',
      variants: undefined,
      sourceTTL: 60_000,
      cacheBytes: 268_435_456,
    });
  });

  it('trims every value, treats blank as unset, and strips trailing slashes off the source', () => {
    const config = readConfig({
      IMAGES_SECRET: ' a , b ,',
      IMAGES_SOURCE: 'http://h:9002/uploads/',
      HOST: '  ',
      PORT: '0',
    });
    deepStrictEqual(config.secrets, ['a', 'b']);
    strictEqual(config.source, 'http://h:9002/uploads');
    strictEqual(config.host, undefined);
    strictEqual(config.port, 0);
  });

  it('needs no secret when unsigned', () => {
    const config = readConfig({ IMAGES_UNSIGNED: '1' });
    strictEqual(config.unsigned, true);
    deepStrictEqual(config.secrets, []);
    strictEqual(readConfig({ ...REQUIRED, IMAGES_UNSIGNED: 'false' }).unsigned, false);
  });

  it('reduces the allowlist by variantOf', () => {
    const config = readConfig({
      ...REQUIRED,
      IMAGES_VARIANTS: 'w_320,h_320,fit_inside,f_webp; w_640,h_360,f_webp,p_top ;',
    });
    deepStrictEqual(
      config.variants,
      new Set(['w_320,h_320,fit_inside,f_webp', 'w_640,h_360,f_webp']),
    );
    strictEqual(readConfig({ ...REQUIRED, IMAGES_VARIANTS: '' }).variants, undefined);
  });

  it('throws one clear line for each invalid value', () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{}, SECRET_REQUIRED],
      [{ IMAGES_SECRET: ' , ' }, SECRET_REQUIRED],
      [
        { ...REQUIRED, IMAGES_SOURCE: 'localhost:9002' },
        '`IMAGES_SOURCE` must be an `http` or `https` URL, got `localhost:9002`.',
      ],
      [
        { ...REQUIRED, IMAGES_SOURCE: 'ftp://x' },
        '`IMAGES_SOURCE` must be an `http` or `https` URL, got `ftp://x`.',
      ],
      [{ ...REQUIRED, IMAGES_UNSIGNED: 'yes' }, '`IMAGES_UNSIGNED` must be `1` or `0`, got `yes`.'],
      [
        { ...REQUIRED, PORT: 'abc' },
        '`PORT` must be an integer between `0` and `65535`, got `abc`.',
      ],
      [
        { ...REQUIRED, PORT: '70000' },
        '`PORT` must be an integer between `0` and `65535`, got `70000`.',
      ],
      [
        { ...REQUIRED, IMAGES_SOURCE_TTL: '-1' },
        '`IMAGES_SOURCE_TTL` must be a whole number of seconds, got `-1`.',
      ],
      [
        { ...REQUIRED, IMAGES_SOURCE_TTL: '1.5' },
        '`IMAGES_SOURCE_TTL` must be a whole number of seconds, got `1.5`.',
      ],
      [
        { ...REQUIRED, IMAGES_CACHE_MB: '0' },
        '`IMAGES_CACHE_MB` must be a positive integer of megabytes, got `0`.',
      ],
      [
        { ...REQUIRED, IMAGES_VARIANTS: 'w_320;rotate_90' },
        '`IMAGES_VARIANTS` lists `rotate_90`, which is not a variant.',
      ],
      [
        { ...REQUIRED, IMAGES_VARIANTS: 'fp_0.5_0.5' },
        '`IMAGES_VARIANTS` lists `fp_0.5_0.5`, which is not a variant.',
      ],
    ];
    for (const [env, message] of cases) throws(() => readConfig(env), { message });
  });
});

describe('parseFlags', () => {
  it('maps every flag to its variable, in both spellings', () => {
    deepStrictEqual(
      parseFlags([
        '--port',
        '9200',
        '--host=127.0.0.1',
        '--secret',
        'a,b',
        '--source=http://h/u',
        '--variants',
        'w_1;w_2',
        '--source-ttl=5',
        '--cache-mb',
        '8',
        '--unsigned',
      ]),
      {
        PORT: '9200',
        HOST: '127.0.0.1',
        IMAGES_SECRET: 'a,b',
        IMAGES_SOURCE: 'http://h/u',
        IMAGES_VARIANTS: 'w_1;w_2',
        IMAGES_SOURCE_TTL: '5',
        IMAGES_CACHE_MB: '8',
        IMAGES_UNSIGNED: '1',
      },
    );
    deepStrictEqual(parseFlags(['--unsigned=0']), { IMAGES_UNSIGNED: '0' });
    deepStrictEqual(parseFlags([]), {});
  });

  it('wins over the environment', () => {
    const config = readConfig({ ...REQUIRED, PORT: '9100', ...parseFlags(['--port', '9200']) });
    strictEqual(config.port, 9200);
  });

  it('throws on an unknown flag or a missing value', () => {
    throws(() => parseFlags(['--colour', 'red']), { message: 'Unknown flag `--colour`.' });
    throws(() => parseFlags(['9200']), { message: 'Unknown flag `9200`.' });
    throws(() => parseFlags(['--port']), { message: '`--port` needs a value.' });
  });
});
