import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PreparedIdentities } from './identities';

export const candidateSources = (): Record<string, string> => {
  const commands = [
    ['git', 'diff', '--name-only', '-z', 'HEAD', '--', 'core', 'jurisdictions'],
    ['git', 'ls-files', '--others', '--exclude-standard', '-z', '--', 'core', 'jurisdictions'],
  ] as const;
  const files = commands.flatMap(command => {
    const result = Bun.spawnSync([...command], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error('USDC_PREFLIGHT_CANDIDATE_DISCOVERY_FAILED');
    return result.stdout
      .toString()
      .split('\0')
      .filter(path => /\.(ts|cjs|sol)$/.test(path));
  });
  return Object.fromEntries(
    [
      ...new Set([
        ...files,
        'package.json',
        'bun.lock',
        'tsconfig.json',
        'tsconfig.runtime.json',
        'tsconfig.deployment.json',
        'frozen-core.json',
      ]),
    ]
      .sort()
      .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
};

/** Provisional allocation, never a measurement or spending authority. */
export const proposeNativeBudget = (identities: PreparedIdentities, funder: string) => {
  const allocation = [
    {
      chainId: 11155111,
      funding: ['0.010', '0.000'],
      user: ['0.030', '0.050'],
      hub: ['0.030', '0.050'],
      mm: ['0.000', '0.030'],
    },
    {
      chainId: 421614,
      funding: ['0.005', '0.000'],
      user: ['0.010', '0.015'],
      hub: ['0.020', '0.020'],
      mm: ['0.000', '0.030'],
    },
  ] as const;
  return {
    status: 'provisional-unapproved',
    approved: false,
    cumulativeEnforcementImplemented: false,
    adapterDefaults: { gasHeadroomBps: 12000, maxFeeGwei: 200, replacementMinimumBumpBps: 1250 },
    explicitFeeEnvironment: Object.fromEntries(
      [
        'JADAPTER_GAS_HEADROOM_BPS',
        'JADAPTER_MAX_FEE_GWEI',
        'XLN_EVM_REPLACEMENT_BUMP_BPS',
        'XLN_EVM_FEE_CEILING_WEI',
      ].map(key => [key, process.env[key] ?? null]),
    ),
    totalLimitsEth: { '11155111': '0.200', '421614': '0.100' },
    payers: allocation.flatMap(chain =>
      (['funding', 'user', 'hub', 'mm'] as const).map(role => {
        const address =
          role === 'funding'
            ? funder
            : identities.find(value => value.role === role)?.chains.find(value => value.chainId === chain.chainId)
                ?.signerId;
        if (!address) throw new Error('USDC_PREFLIGHT_BUDGET_PAYER_MISSING');
        const amounts = chain[role];
        return { chainId: chain.chainId, role, address, normalEth: amounts[0], recoveryEth: amounts[1] };
      }),
    ),
    missingEstimates: [
      { chainId: 11155111, payer: 'funding', stages: ['operator-e2r-to-source-hub-reserve'] },
      {
        chainId: 11155111,
        payer: 'user',
        stages: ['source-e2r', 'source-r2c', 'source-recovery-dispute-and-finalize'],
      },
      { chainId: 421614, payer: 'funding', stages: ['operator-e2r-to-hub-reserve'] },
      { chainId: 421614, payer: 'hub', stages: ['signed-fee-cover-r2c', 'hub-recovery-dispute-and-finalize'] },
      { chainId: 421614, payer: 'user', stages: ['bilateral-c2r-settlement', 'r2e-to-address-b', 'user-recovery'] },
      { chainId: 'both', payer: 'mm', stages: ['operator-recovery-if-required'] },
    ],
    assumptions: [
      'ETH is native gas only; USDC principal, operator liquidity and internal ETH funding transfers are separate.',
      'Recovery allocations are reserved portions of each payer limit, not extra limits.',
      'Replacement transactions share the same cumulative payer limit; pending liabilities must be reserved before replacement.',
      'No forced public dispute or public recovery calldata has been estimated; allocations remain provisional.',
      'A changed quote, tariff, payer, calldata, deployment, RPC or chain point invalidates the affected preparation.',
      'Arbitrum total gas already contains its L1 poster component; never add that component twice.',
    ],
  };
};
