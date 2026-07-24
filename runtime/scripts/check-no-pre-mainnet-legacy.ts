import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const banned = [
  {
    symbol: 'processJBlockEvents',
    files: ['runtime/runtime.ts', 'runtime/xln-api.ts'],
  },
  {
    symbol: 'evms:',
    files: ['runtime/types.ts', 'runtime/runtime.ts', 'runtime/scenarios/settle.ts'],
  },
  {
    symbol: '.evms',
    files: ['runtime/runtime.ts'],
  },
] as const;

const violations = banned.flatMap(entry => entry.files.flatMap(file => {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  return source.includes(entry.symbol) ? [`${file}:${entry.symbol}`] : [];
}));

if (violations.length > 0) {
  throw new Error(`PRE_MAINNET_LEGACY_SURFACE_RETURNED:\n${violations.join('\n')}`);
}

console.log(`PRE_MAINNET_LEGACY_SURFACE_OK symbols=${banned.length}`);
