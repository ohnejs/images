import type { AddressInfo } from 'node:net';

import { once } from 'node:events';

import { parseFlags, readConfig } from './config.ts';
import { createImageServer } from './server.ts';

const USAGE = `Usage: ohne-images [flags]

  --port <number>            PORT                  9100
  --host <address>           HOST                  every interface
  --secret <list>            IMAGES_SECRET         comma-separated; required unless --unsigned
  --source <origin>          IMAGES_SOURCE         http://localhost:9001/uploads
  --source-secret <secret>   IMAGES_SOURCE_SECRET  signs an expiring URL's fetch; one of ohne's UPLOADS_SECRET values
  --variants <list>          IMAGES_VARIANTS       semicolon-separated token strings; unset renders every size
  --source-ttl <s>           IMAGES_SOURCE_TTL     60
  --cache-mb <number>        IMAGES_CACHE_MB       256
  --unsigned                 IMAGES_UNSIGNED       render every URL without a signature check
  --help

A flag wins over its environment variable.
`;

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write(USAGE);
} else {
  try {
    const config = readConfig({ ...process.env, ...parseFlags(argv) });
    const server = createImageServer(config);
    server.listen(config.port, config.host);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    console.log(`ohne-images ready at http://${config.host ?? 'localhost'}:${port}`);
    if (config.unsigned) {
      process.stderr.write('ohne-images: unsigned, every URL renders; keep this instance local\n');
    }
  } catch (error) {
    process.stderr.write(
      `ohne-images: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
