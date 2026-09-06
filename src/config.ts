import { parseImageTransforms, variantOf } from './transforms.ts';

/**
 * What the service runs with, read from the environment once at start.
 */
export interface Config {
  /**
   * The TCP port the server listens on.
   *
   * @default
   * 9100
   */
  port: number;

  /**
   * The address the server binds.
   * Omitted, the server binds every interface.
   */
  host: string | undefined;

  /**
   * The secrets a signature may verify under, in the order `IMAGES_SECRET` lists them.
   * Empty only when `unsigned`.
   */
  secrets: string[];

  /**
   * Whether every URL renders with no signature check, whatever its first segment holds.
   * Meant for a local machine; an unsigned instance renders for anyone who can reach it.
   *
   * @default
   * false
   */
  unsigned: boolean;

  /**
   * The origin a source path is fetched from, without trailing slashes.
   *
   * @default
   * 'http://localhost:9001/uploads'
   */
  source: string;

  /**
   * The variants a verified URL may ask for, each reduced by `variantOf`.
   * Omitted, every verified URL is rendered.
   */
  variants: Set<string> | undefined;

  /**
   * Milliseconds a fetched source is trusted before it is revalidated with `If-None-Match`.
   *
   * @default
   * 60_000
   */
  sourceTTL: number;

  /**
   * The byte budget of each in-memory cache, rendered variants and source bytes alike.
   *
   * @default
   * 268_435_456
   */
  cacheBytes: number;
}

const DEFAULT_SOURCE = 'http://localhost:9001/uploads';

const FLAGS: Record<string, string> = {
  port: 'PORT',
  host: 'HOST',
  secret: 'IMAGES_SECRET',
  source: 'IMAGES_SOURCE',
  variants: 'IMAGES_VARIANTS',
  'source-ttl': 'IMAGES_SOURCE_TTL',
  'cache-mb': 'IMAGES_CACHE_MB',
  unsigned: 'IMAGES_UNSIGNED',
};

/**
 * Reads the service configuration from `env`, normally `process.env` with `parseFlags` spread over it.
 *
 * Every value is trimmed and `''` counts as unset.
 * `IMAGES_SECRET` is required unless `IMAGES_UNSIGNED` is on; the rest fall back to their defaults.
 * The first invalid value throws one line naming the variable, what it must be, and what it got.
 *
 * @example
 * ```ts
 * readConfig({ IMAGES_SECRET: 'a, b' })
 * // -> { port: 9100, secrets: ['a', 'b'], unsigned: false, source: 'http://localhost:9001/uploads', ... }
 * ```
 */
export function readConfig(env: Record<string, string | undefined>): Config {
  const unsigned = flag(env, 'IMAGES_UNSIGNED');
  const secrets = list(env.IMAGES_SECRET, ',');
  if (secrets.length === 0 && !unsigned) {
    throw new Error(
      '`IMAGES_SECRET` is required unless `--unsigned` is set: comma-separated secrets, a URL signed by any of them is accepted.',
    );
  }
  const source = env.IMAGES_SOURCE?.trim() || DEFAULT_SOURCE;
  if (!/^https?:$/.test(URL.parse(source)?.protocol ?? '')) {
    throw new Error(`\`IMAGES_SOURCE\` must be an \`http\` or \`https\` URL, got \`${source}\`.`);
  }
  const port = integer(env, 'PORT', 9100, 0, 65535, 'an integer between `0` and `65535`');
  const seconds = integer(env, 'IMAGES_SOURCE_TTL', 60, 0, Infinity, 'a whole number of seconds');
  const megabytes = integer(
    env,
    'IMAGES_CACHE_MB',
    256,
    1,
    Infinity,
    'a positive integer of megabytes',
  );
  const variants = list(env.IMAGES_VARIANTS, ';');
  for (const entry of variants) {
    if (parseImageTransforms(entry) === undefined || variantOf(entry) === '') {
      throw new Error(`\`IMAGES_VARIANTS\` lists \`${entry}\`, which is not a variant.`);
    }
  }
  return {
    port,
    host: env.HOST?.trim() || undefined,
    secrets,
    unsigned,
    source: source.replace(/\/+$/, ''),
    variants: variants.length > 0 ? new Set(variants.map(variantOf)) : undefined,
    sourceTTL: seconds * 1000,
    cacheBytes: megabytes * 1024 * 1024,
  };
}

/**
 * The environment `argv` stands for: `--name value` and `--name=value` set the variable behind a flag.
 * `--unsigned` alone means `1`.
 * An unknown flag, or one missing its value, throws one line naming it.
 *
 * @example
 * ```ts
 * parseFlags(['--unsigned', '--port', '9200', '--source=http://localhost:9002/uploads'])
 * // -> { IMAGES_UNSIGNED: '1', PORT: '9200', IMAGES_SOURCE: 'http://localhost:9002/uploads' }
 * ```
 */
export function parseFlags(argv: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    const variable = arg.startsWith('--') ? FLAGS[name] : undefined;
    if (variable === undefined) throw new Error(`Unknown flag \`${arg}\`.`);
    if (equals !== -1) {
      env[variable] = arg.slice(equals + 1);
    } else if (name === 'unsigned') {
      env[variable] = '1';
    } else {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`\`${arg}\` needs a value.`);
      env[variable] = value;
    }
  }
  return env;
}

/**
 * The non-empty trimmed entries of `raw` split on `separator`; `[]` when unset.
 */
function list(raw: string | undefined, separator: string): string[] {
  return (raw ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A whole number read from `env[name]` within `min` and `max`, or `fallback` when unset.
 * Anything else throws naming the variable, what it must be, and the value it got.
 */
function integer(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
  expected: string,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw new Error(`\`${name}\` must be ${expected}, got \`${raw}\`.`);
  }
  return value;
}

/**
 * A switch read from `env[name]`: `1` or `true` is on; unset, `0`, or `false` is off.
 * Anything else throws naming the variable.
 */
function flag(env: Record<string, string | undefined>, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new Error(`\`${name}\` must be \`1\` or \`0\`, got \`${raw}\`.`);
}
