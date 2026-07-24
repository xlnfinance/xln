import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveAccountWatchSeed } from '../account/watch-seed';
import { applyAccountInput } from '../entity/tx/handlers/account';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica, EntityState, JurisdictionConfig } from '../types';

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
  messages: [],
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
  jBlockChain: [],
  entityEncPubKey: `0x${'11'.repeat(32)}`,
  entityEncPrivKey: `0x${'22'.repeat(32)}`,
  profile: {
    name: 'Account Handler Test Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
});

test('account handlers keep failures behind structured logging', () => {
  const account = readFileSync(join(process.cwd(), 'runtime/entity/tx/handlers/account.ts'), 'utf8');
  const openAccount = readFileSync(join(process.cwd(), 'runtime/entity/tx/handlers/open-account.ts'), 'utf8');

  expect(account).toContain("const accountHandlerLog = createStructuredLogger('account.handler');");
  expect(openAccount).toContain("const openAccountLog = createStructuredLogger('account.open');");
  expect(account).not.toContain('console.');
  expect(openAccount).not.toContain('console.');
  expect(account).toContain('ACCOUNT_INPUT_EMPTY');
});

test('account input without frame or settlement action fails fast', async () => {
  const env = createEmptyEnv('account-input-empty-failfast');
  env.runtimeSeed = 'account-input-empty-failfast-seed';
  env.runtimeId = `0x${'33'.repeat(20)}`;
  const state = makeEntityState();
  env.eReplicas.set(`${counterpartyId}:counterparty-signer`, {
    entityId: counterpartyId,
    signerId: 'counterparty-signer',
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
    timestamp: env.timestamp,
  });
  const previousScopes = process.env['XLN_LOG_SCOPES'];
  process.env['XLN_LOG_SCOPES'] = 'none';

  try {
    await expect(applyAccountInput(state, {
      fromEntityId: counterpartyId,
      toEntityId: entityId,
      watchSeed,
      domain: {
        chainId: jurisdiction.chainId!,
        depositoryAddress: jurisdiction.depositoryAddress,
      },
    }, env)).rejects.toThrow('ACCOUNT_GENESIS_FRAME_REQUIRED');
    expect(state.messages.at(-1)).toContain('ACCOUNT_GENESIS_FRAME_REQUIRED');
  } finally {
    if (previousScopes === undefined) delete process.env['XLN_LOG_SCOPES'];
    else process.env['XLN_LOG_SCOPES'] = previousScopes;
  }
});
