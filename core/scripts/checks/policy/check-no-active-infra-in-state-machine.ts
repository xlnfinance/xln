import { readFile } from 'node:fs/promises';

const TARGETS = [
  'core/entity/tx/apply.ts',
  'core/entity/tx/j-events.ts',
  'core/entity/tx/handlers/dispute/index.ts',
  'core/entity/tx/handlers/dispute/shared.ts',
  'core/entity/tx/handlers/dispute/start.ts',
  'core/entity/tx/handlers/dispute/start-admission.ts',
  'core/entity/tx/handlers/dispute/start-evidence.ts',
  'core/entity/tx/handlers/dispute/start-hanko.ts',
  'core/entity/tx/handlers/dispute/finalize.ts',
  'core/entity/tx/handlers/dispute/finalize-admission.ts',
  'core/entity/tx/handlers/dispute/finalize-proof.ts',
  'core/entity/tx/handlers/j-batch/j-broadcast.ts',
  'core/account/consensus/index.ts',
  'core/entity/consensus/leader/certificates.ts',
  'core/entity/consensus/j-prefix/prefix-round.ts',
  'core/entity/consensus/state-quota.ts',
  'core/entity/consensus/input/consensus.ts',
  'core/entity/consensus/frame/application.ts',
  'core/runtime/j-submit/j-submit.ts',
];

const BANNED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\.getAccountInfo\s*\(/g, label: 'jadapter.getAccountInfo' },
  { pattern: /\.getEntityNonce\s*\(/g, label: 'jadapter.getEntityNonce' },
  { pattern: /\.hasProcessedBatch\s*\(/g, label: 'jadapter.hasProcessedBatch' },
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
