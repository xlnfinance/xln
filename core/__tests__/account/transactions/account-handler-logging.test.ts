import { expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveAccountWatchSeed } from '../../../protocol/identity/account-watch-seed';
import { applyAccountInputToEntity } from '../../../entity/tx/handlers/account/index';
import { createEmptyEnv } from '../../../runtime';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import type { EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { AccountInput } from '../../../types/account';

const entityId = `0x${'aa'.repeat(32)}`;
const counterpartyId = `0x${'bb'.repeat(32)}`;
const jurisdiction: JurisdictionConfig = {
  name: 'Testnet',
  address: 'http://localhost:8545',
  chainId: 31337,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  entityProviderAddress: `0x${'22'.repeat(20)}`,
};

const makeEntityState = (): EntityState => ({
  entityId,
  height: 0,
  timestamp: 123,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: ['signer'],
    shares: { signer: 1n },
    threshold: 1n,
    jurisdiction,
  },
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  profile: {
    name: 'Account Handler Test Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  paybook: { entries: new Map(), feesEarned: 0n },
  swapTradingPairs: [],
});

test('account handlers keep failures behind structured logging', () => {
  const account = readFileSync(join(process.cwd(), 'core/entity/tx/handlers/account/index.ts'), 'utf8');
  const inputPhases = readFileSync(
    join(process.cwd(), 'core/entity/tx/handlers/account/input-phases.ts'),
    'utf8',
  );
  const openAccount = readFileSync(join(process.cwd(), 'core/entity/tx/handlers/account/lifecycle/open-account.ts'), 'utf8');

  expect(account).toContain("const accountHandlerLog = createStructuredLogger('account.handler');");
  expect(inputPhases).toContain("const accountHandlerLog = createStructuredLogger('account.handler');");
  expect(openAccount).toContain("const openAccountLog = createStructuredLogger('account.open');");
  expect(account).not.toContain('console.');
  expect(inputPhases).not.toContain('console.');
  expect(openAccount).not.toContain('console.');
  expect(inputPhases).toContain('ACCOUNT_INPUT_EMPTY');
});

test('account input without frame or settlement action fails fast', async () => {
  const env = createEmptyEnv('account-input-empty-failfast');
  env.runtimeSeed = 'account-input-empty-failfast-seed';
  env.runtimeId = `0x${'33'.repeat(20)}`;
  const state = makeEntityState();
  env.state.eReplicas.set(`${counterpartyId}:counterparty-signer`, {
    entityId: counterpartyId,
    signerId: 'counterparty-signer',
    entityEncPubKey: '',
    isProposer: true,
    mempool: [],
    state: {
      ...makeEntityState(),
      entityId: counterpartyId,
      config: {
        ...makeEntityState().config,
        validators: ['counterparty-signer'],
        shares: { 'counterparty-signer': 1n },
      },
    },
  } as EntityReplica);
  const watchSeed = deriveAccountWatchSeed({
    runtimeSeed: env.runtimeSeed,
    runtimeId: env.runtimeId,
    entityId,
    counterpartyId,
  });
  const previousScopes = process.env['XLN_LOG_SCOPES'];
  process.env['XLN_LOG_SCOPES'] = 'none';

  try {
    await expect(applyAccountInputToEntity(state, {
      fromEntityId: counterpartyId,
      toEntityId: entityId,
      watchSeed,
      domain: {
        chainId: jurisdiction.chainId!,
        depositoryAddress: jurisdiction.depositoryAddress,
      },
    }, env, createAccountConsensusContext(env))).rejects.toThrow('ACCOUNT_GENESIS_FRAME_REQUIRED');
    expect(readEntityFrameEventMessages(state).at(-1)).toContain('ACCOUNT_GENESIS_FRAME_REQUIRED');
  } finally {
    if (previousScopes === undefined) delete process.env['XLN_LOG_SCOPES'];
    else process.env['XLN_LOG_SCOPES'] = previousScopes;
  }
});

test('unknown Account rejects the retired standalone frame input', async () => {
  const env = createEmptyEnv('account-input-standalone-frame-failfast');
  env.runtimeSeed = 'account-input-standalone-frame-failfast-seed';
  env.runtimeId = `0x${'33'.repeat(20)}`;
  const state = makeEntityState();
  const watchSeed = deriveAccountWatchSeed({
    runtimeSeed: env.runtimeSeed,
    runtimeId: env.runtimeId,
    entityId,
    counterpartyId,
  });
  const retired = {
    kind: 'frame',
    fromEntityId: counterpartyId,
    toEntityId: entityId,
    watchSeed,
    domain: {
      chainId: jurisdiction.chainId!,
      depositoryAddress: jurisdiction.depositoryAddress,
    },
  } as unknown as AccountInput;

  await expect(applyAccountInputToEntity(
    state,
    retired,
    env,
    createAccountConsensusContext(env),
  )).rejects.toThrow('ACCOUNT_GENESIS_FRAME_REQUIRED');
});
