#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const SOURCES = new URL('./src/', import.meta.url).href;

// Node warns once per process, so spending the warning muted keeps every later strip silent.
const emitWarning = process.emitWarning;
process.emitWarning = () => {};
stripTypeScriptTypes('');
process.emitWarning = emitWarning;

// Node refuses to strip types under `node_modules`, so an installed copy strips its own sources.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(SOURCES) || !url.endsWith('.ts')) return nextLoad(url, context);
    return {
      format: 'module',
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { sourceUrl: url }),
      shortCircuit: true,
    };
  },
});

await import('./src/main.ts');
