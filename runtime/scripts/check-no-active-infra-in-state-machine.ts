import { readFile } from 'node:fs/promises';

const TARGETS = [
  'runtime/entity-tx/apply.ts',
  'runtime/entity-tx/j-events.ts',
  'runtime/entity-tx/handlers/dispute.ts',
  'runtime/entity-tx/handlers/j-broadcast.ts',
  'runtime/account-consensus.ts',
  'runtime/entity-consensus.ts',
];

const BANNED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\.getAccountInfo\s*\(/g, label: 'jadapter.getAccountInfo' },
  { pattern: /\.defaultDisputeDelay\s*\(/g, label: 'depository.defaultDisputeDelay' },
  { pattern: /\._collaterals\s*\(/g, label: 'depository._collaterals' },
  { pattern: /\.provider\.getBlockNumber\s*\(/g, label: 'provider.getBlockNumber' },
  { pattern: /\.processBlock\s*\(/g, label: 'jadapter.processBlock' },
];

async function main(): Promise<void> {
  const failures: string[] = [];

  for (const target of TARGETS) {
    const source = await readFile(target, 'utf8');
    for (const { pattern, label } of BANNED_PATTERNS) {
      const matches = [...source.matchAll(pattern)];
      for (const match of matches) {
        const index = match.index ?? 0;
        const line = source.slice(0, index).split('\n').length;
        failures.push(`${target}:${line} banned active infra call: ${label}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error('State-machine layer must not actively call infra/jadapter:\n' + failures.join('\n'));
    process.exit(1);
  }
}

await main();
