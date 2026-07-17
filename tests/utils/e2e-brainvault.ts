import { execFileSync } from 'node:child_process';

export type BrainvaultCliOutput = {
  mnemonic24: string;
  mnemonic12: string;
};

export const normalizeBrainvaultMnemonic = (value: string): string =>
  value.trim().split(/\s+/).join(' ');

export function runBrainvaultCli(
  name: string,
  passphrase: string,
  shards: number,
): BrainvaultCliOutput {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`BRAINVAULT_CLI_SHARDS_INVALID:${String(shards)}`);
  }
  const output = execFileSync(
    'bun',
    ['brainvault/cli.ts', name, passphrase, String(shards), '--w=4'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    },
  );
  const jsonStart = output.lastIndexOf('\n{');
  const objectStart = jsonStart >= 0 ? jsonStart + 1 : output.indexOf('{');
  if (objectStart < 0) throw new Error('BRAINVAULT_CLI_OUTPUT_MISSING');
  const parsed: unknown = JSON.parse(output.slice(objectStart).trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('BRAINVAULT_CLI_OUTPUT_INVALID');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record['mnemonic24'] !== 'string' || typeof record['mnemonic12'] !== 'string') {
    throw new Error('BRAINVAULT_CLI_MNEMONICS_MISSING');
  }
  return {
    mnemonic24: normalizeBrainvaultMnemonic(record['mnemonic24']),
    mnemonic12: normalizeBrainvaultMnemonic(record['mnemonic12']),
  };
}
