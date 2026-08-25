import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createAccountConsensusContext } from '../../entity/account/account-consensus-context';
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import type { EntityState, JurisdictionConfig } from '../../entity/types';
import { applyAccountInputToEntity } from '../../entity/tx/handlers/account';
import { handleOpenAccountEntityTx } from '../../entity/tx/handlers/account/lifecycle/open-account';
import { createEmptyEnv } from '../../runtime';
import {
  beginAuthorityFrame,
  buildAuthorityWave,
  noteAuthorityAccountCreate,
  noteAuthorityEntityClock,
  resetAuthorityRecordForTests,
} from '../../rscore/authority-wave';
import { accountEnvelopeWire } from '../../rscore/shadow-wire';
import type { AccountPeerInput, AccountReplica } from '../../types/account';
import { createTestJReplica } from '../helpers/j-replica';

const OWNER = `0x${'aa'.repeat(32)}`;
const PEER = `0x${'bb'.repeat(32)}`;
const WATCH_SEED = `0x${'cc'.repeat(32)}`;
const DELTA_TRANSFORMER = `0x${'dd'.repeat(20)}`;
const FRAME_ID = 'authority-create';
const JURISDICTION: JurisdictionConfig = {
  name: 'authority-create',
  address: 'rpc://authority-create',
  chainId: 31_337,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  entityProviderAddress: `0x${'22'.repeat(20)}`,
};

const makeState = (): EntityState => ({
  entityId: OWNER,
  entityEncryptionPublicKey: `0x${'33'.repeat(32)}`,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: ['signer'],
    shares: { signer: 1n },
    threshold: 1n,
    jurisdiction: JURISDICTION,
  },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(OWNER, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  profile: { name: 'authority-create', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const makeContext = () => {
  const env = createEmptyEnv(`authority-create-${process.pid}`);
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000;
  env.accountAuthorityFrameId = FRAME_ID;
  env.state.jReplicas.set(JURISDICTION.name, createTestJReplica({
    name: JURISDICTION.name,
    chainId: JURISDICTION.chainId,
    rpcs: [JURISDICTION.address],
    contracts: {
      depository: JURISDICTION.depositoryAddress,
      entityProvider: JURISDICTION.entityProviderAddress,
      account: `0x${'44'.repeat(20)}`,
      deltaTransformer: DELTA_TRANSFORMER,
    },
  }));
  return { env, accountContext: createAccountConsensusContext(env) };
};

const openLocally = async () => {
  const state = makeState();
  const { accountContext } = makeContext();
  beginAuthorityFrame(FRAME_ID);
  noteAuthorityEntityClock(FRAME_ID, OWNER, 'enforce', 1_000, 0);
  const result = await handleOpenAccountEntityTx(state, {
    type: 'openAccount',
    data: {
      targetEntityId: PEER,
      watchSeed: WATCH_SEED,
      accountDomain: {
        chainId: JURISDICTION.chainId,
        depositoryAddress: JURISDICTION.depositoryAddress,
      },
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    },
  }, accountContext);
  const account = result.newState.accounts.get(PEER);
  if (!account) throw new Error('TEST_LOCAL_ACCOUNT_MISSING');
  return { account, wave: buildAuthorityWave(FRAME_ID) };
};

describe('authority Account creation collection', () => {
  beforeEach(() => {
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    resetAuthorityRecordForTests();
  });

  afterEach(() => {
    delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
    resetAuthorityRecordForTests();
  });

  test('local H0 is Create then Admit, with the final leaf and an empty mempool', async () => {
    const { account, wave } = await openLocally();
    if (wave.kind !== 'wave') throw new Error(`TEST_WAVE_REQUIRED:${wave.kind}`);
    const entity = wave.entities[0];
    if (!entity) throw new Error('TEST_ENTITY_WAVE_MISSING');
    const ops = entity.ops as unknown[][];

    expect(ops.map(op => op[0])).toEqual([2, 0]);
    expect(entity.operations).toEqual([
      {
        operationIndex: 0,
        arrivalIndex: 0,
        accountId: PEER,
        resultKind: 'none',
        expectedVerdict: { kind: 'create' },
      },
      {
        operationIndex: 1,
        arrivalIndex: 1,
        accountId: PEER,
        resultKind: 'admission',
        expectedVerdict: { kind: 'admission', admittedCount: 3 },
      },
    ]);

    const seed = ops[0]?.[2] as unknown[];
    const exactH0 = { ...account, mempool: [] } as AccountReplica;
    expect(seed[12]).toEqual(accountEnvelopeWire(exactH0));
    expect(seed[13]).toBeNull();
    expect(seed[14]).toEqual(Uint8Array.from(Buffer.from(DELTA_TRANSFORMER.slice(2), 'hex')));
    expect((seed[12] as unknown[][])[1]).toEqual([]);
    const leafFields = ((seed[12] as unknown[][])[0]?.[1] as unknown[][])
      .map(field => field[0]);
    expect(leafFields).toContain('publicPinned');
    expect(leafFields).toContain('shadow');
  });

  test('inbound H0 is Create immediately before its peer Input', async () => {
    const state = makeState();
    const { env, accountContext } = makeContext();
    beginAuthorityFrame(FRAME_ID);
    noteAuthorityEntityClock(FRAME_ID, OWNER, 'enforce', env.state.timestamp, 0);
    const input: AccountPeerInput = {
      kind: 'frame',
      fromEntityId: PEER,
      toEntityId: OWNER,
      domain: {
        chainId: JURISDICTION.chainId,
        depositoryAddress: JURISDICTION.depositoryAddress,
      },
      watchSeed: WATCH_SEED,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      proposal: {
        frameHanko: `0x${'55'.repeat(64)}`,
        frame: {
          height: 1,
          timestamp: 1_000,
          jHeight: 0,
          accountTxs: [],
          prevFrameHash: 'genesis',
          accountStateRoot: `0x${'66'.repeat(32)}`,
          stateHash: `0x${'77'.repeat(32)}`,
          deltas: [],
          byLeft: false,
        },
      },
    };

    await expect(applyAccountInputToEntity(state, input, env, accountContext))
      .rejects.toThrow('ACCOUNT_PEER_INPUT_REJECTED:ACCOUNT_PEER_FRAME_HANKO_INVALID');
    const wave = buildAuthorityWave(FRAME_ID);
    if (wave.kind !== 'wave') throw new Error(`TEST_WAVE_REQUIRED:${wave.kind}`);
    const entity = wave.entities[0];
    if (!entity) throw new Error('TEST_ENTITY_WAVE_MISSING');
    const ops = entity.ops as unknown[][];
    expect(ops.map(op => op[0])).toEqual([2, 1]);
    expect(entity.operations).toEqual([
      {
        operationIndex: 0,
        arrivalIndex: 0,
        accountId: PEER,
        resultKind: 'none',
        expectedVerdict: { kind: 'create' },
      },
      {
        operationIndex: 1,
        arrivalIndex: 1,
        accountId: PEER,
        resultKind: 'applied',
        expectedVerdict: {
          kind: 'peer',
          outcome: 'rejected',
          committedFrames: [],
          responseAckHanko: null,
          events: [],
        },
      },
    ]);
    expect(wave.inputs).toEqual([{
      operationIndex: 1,
      arrivalIndex: 1,
      ownerEntityId: OWNER,
      accountId: PEER,
      kind: 'frame',
    }]);
  });

  test('Create-only work is retained, while duplicate and non-H0 creates are loud', async () => {
    const { account } = await openLocally();
    resetAuthorityRecordForTests();
    beginAuthorityFrame(FRAME_ID);
    noteAuthorityEntityClock(FRAME_ID, OWNER, 'enforce', 1_000, 0);
    const h0 = { ...account, mempool: [] } as AccountReplica;
    noteAuthorityAccountCreate(FRAME_ID, OWNER, PEER, h0, DELTA_TRANSFORMER);
    const createOnly = buildAuthorityWave(FRAME_ID);
    if (createOnly.kind !== 'wave') throw new Error(`TEST_WAVE_REQUIRED:${createOnly.kind}`);
    expect(createOnly.entities[0]?.operations).toEqual([
      {
        operationIndex: 0,
        arrivalIndex: 0,
        accountId: PEER,
        resultKind: 'none',
        expectedVerdict: { kind: 'create' },
      },
    ]);

    noteAuthorityAccountCreate(FRAME_ID, OWNER, PEER, h0, DELTA_TRANSFORMER);
    expect(buildAuthorityWave(FRAME_ID)).toEqual({
      kind: 'ineligible',
      reason: `create:duplicate:${OWNER}/${PEER}`,
    });
    expect(() => noteAuthorityAccountCreate(
      FRAME_ID,
      OWNER,
      PEER,
      { ...h0, currentHeight: 1 },
      DELTA_TRANSFORMER,
    )).toThrow(`AUTHORITY_CREATE_NOT_H0:${OWNER}:${PEER}`);
  });
});
