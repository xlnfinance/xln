import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AbiCoder, Interface, ParamType, Wallet, keccak256, solidityPacked, toUtf8Bytes } from 'ethers';
import { createWatchtowerStore } from '../watchtower/store';
import {
  assertWatchtowerRpcUrlAllowed,
  decodeTowerCounterDisputeRemedy,
  encodeTowerCounterDisputeRemedy,
  runWatchtowerSweep,
} from '../watchtower/action';
import { encryptTowerPayloadForWatchSeed } from '../storage/recovery/crypto';
import type { TowerAppointmentV1 } from '../storage/recovery/types';

const makeLookupKey = (label: string): string => keccak256(toUtf8Bytes(label));
const disputeStartedInterface = new Interface([
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bool proposerIsLeft, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterCounterArguments, bytes32 starterCounterProofCommitment, uint256 disputeTimeout, uint256 disputeStartTimestamp, uint32 leftResponseSeconds, uint32 rightResponseSeconds)',
]);
const abiCoder = AbiCoder.defaultAbiCoder();
const emptyCounterProofCommitment = `0x${'00'.repeat(32)}`;
const proofBodyParam = ParamType.from(
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)',
);
const makeProofBody = (watchSeed: string, offdeltas: bigint[] = [-1n]): Record<string, unknown> => ({
  watchSeed,
  leftResponseSeconds: 4n,
  rightResponseSeconds: 6n,
  offdeltas,
  tokenIds: [1n],
  transformers: [],
});
const proofBodyHashOf = (proofBody: Record<string, unknown>): string =>
  keccak256(abiCoder.encode([proofBodyParam], [proofBody]));

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    await rm(root, { recursive: true, force: true });
  }
});

const encodeDisputeHash = (
  initialNonce: number,
  startedByLeft: boolean,
  initialProposerIsLeft: boolean,
  disputeTimeout: bigint,
  leftResponseSeconds: bigint,
  rightResponseSeconds: bigint,
  initialProofbodyHash: string,
  disputeStartTimestamp: bigint,
  starterInitialArguments: string,
  starterCounterArguments: string,
  starterCounterProofCommitment = emptyCounterProofCommitment,
  counterNonce = 0n,
  counterProofbodyHash = `0x${'00'.repeat(32)}`,
  counterProposerIsLeft = false,
): string => keccak256(
  solidityPacked(
    ['uint256', 'bool', 'bool', 'uint256', 'uint32', 'uint32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bool'],
    [
      BigInt(initialNonce),
      startedByLeft,
      initialProposerIsLeft,
      disputeTimeout,
      leftResponseSeconds,
      rightResponseSeconds,
      initialProofbodyHash,
      disputeStartTimestamp,
      keccak256(abiCoder.encode(['bytes', 'bool', 'uint256'], [starterInitialArguments, startedByLeft, disputeStartTimestamp])),
      keccak256(abiCoder.encode(['bytes', 'bool', 'uint256'], [starterCounterArguments, startedByLeft, disputeStartTimestamp])),
      starterCounterProofCommitment,
      counterNonce,
      counterProofbodyHash,
      counterProposerIsLeft,
    ],
  ),
);

describe('watchtower delayed last-resort sweep', () => {
  test('rejects malformed signed remedy authority instead of repairing it', async () => {
    const remedy = {
      version: 1 as const,
      type: 'counter_dispute_remedy' as const,
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 31337,
      depositoryAddress: `0x${'11'.repeat(20)}`,
      watchedEntityId: `0x${'22'.repeat(32)}`,
      towerAddress: `0x${'33'.repeat(20)}`,
      lastResortWindowSeconds: 8,
      appointmentSequence: 1,
      ownerAuthorizationHanko: '0xbeef',
      latestProof: {
        counterentity: `0x${'44'.repeat(32)}`,
        finalNonce: 2,
        proposerIsLeft: false,
        finalProofbody: makeProofBody(`0x${'55'.repeat(32)}`),
        leftArguments: '0x',
        rightArguments: '0x',
        sig: '0xcafe',
      },
    };

    await expect(decodeTowerCounterDisputeRemedy(encodeTowerCounterDisputeRemedy({
      ...remedy,
      appointmentSequence: 1.5,
    }))).rejects.toThrow('WATCHTOWER_REMEDY_APPOINTMENT_SEQUENCE_INVALID');
    await expect(decodeTowerCounterDisputeRemedy(encodeTowerCounterDisputeRemedy({
      ...remedy,
      ownerAuthorizationHanko: '0xnot-hex',
    }))).rejects.toThrow('WATCHTOWER_REMEDY_OWNER_AUTHORIZATION_HANKO_INVALID');
    await expect(decodeTowerCounterDisputeRemedy(encodeTowerCounterDisputeRemedy({
      ...remedy,
      latestProof: { ...remedy.latestProof, sig: '' },
    }))).rejects.toThrow('WATCHTOWER_REMEDY_SIGNATURE_INVALID');
  });

  test('allows configured public RPC slots by default', () => {
    expect(assertWatchtowerRpcUrlAllowed('https://xln.finance/rpc2')).toBe('https://xln.finance/rpc2');
    expect(assertWatchtowerRpcUrlAllowed('https://xln.finance/rpc8')).toBe('https://xln.finance/rpc8');
  });

  test('rejects plaintext last-resort remedies before storage', async () => {
    const runtimeWallet = Wallet.createRandom();
    const towerWallet = Wallet.createRandom();
    const lookupKey = makeLookupKey('tower:last-resort:plaintext-store-reject');
    const tempRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-plaintext-${Date.now()}`);
    tempRoots.push(tempRoot);
    await mkdir(tempRoot, { recursive: true });

    const store = createWatchtowerStore({
      towerId: 'tower-last-resort-plaintext',
      dbPath: join(tempRoot, 'tower.level'),
      towerPrivateKey: towerWallet.privateKey,
    });

    await expect(store.upsertAppointment({
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey,
      slot: 0,
      bundle: {
        version: 1,
        runtimeId: runtimeWallet.address.toLowerCase(),
        lookupKey,
        height: 1,
        createdAt: 1_717_171_716_000,
        bundleHash: keccak256(toUtf8Bytes('bundle:plaintext-reject')),
        iv: '0x1234',
        ciphertext: '0xabcd',
      },
      lastResortPayload: {
        triggerHint: 'chain:31337:acct:plaintext',
        encryptedRemedy: encodeTowerCounterDisputeRemedy({
          version: 1,
          type: 'counter_dispute_remedy',
          rpcUrl: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x1111111111111111111111111111111111111111',
          watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          towerAddress: towerWallet.address.toLowerCase(),
          lastResortWindowSeconds: 8,
          appointmentSequence: 1,
          ownerAuthorizationHanko: '0xbeef',
          latestProof: {
            counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            finalNonce: 2,
            proposerIsLeft: false,
            finalProofbody: makeProofBody(`0x${'ee'.repeat(32)}`),
            leftArguments: '0x',
            rightArguments: '0x',
            sig: '0xcafe',
          },
        }),
        watch: {
          rpcUrl: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x1111111111111111111111111111111111111111',
          watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        actionKind: 'counter_dispute_only',
        appointmentSequence: 1,
        proofNonce: 2,
        proofBodyHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        responseMode: 'last_resort',
        lastResortWindowSeconds: 8,
      },
      ownerProof: {
        runtimeId: runtimeWallet.address.toLowerCase(),
        signedAt: Date.now(),
        signature: '0xdead',
      },
    })).rejects.toThrow('TOWER_LAST_RESORT_PAYLOAD_REMEDY_NOT_ENCRYPTED');
  });

  test('submits a delayed counter-dispute and records an action receipt', async () => {
    const runtimeWallet = Wallet.createRandom();
    const towerWallet = Wallet.createRandom();
    const lookupKey = makeLookupKey('tower:last-resort:submit');
    const watchedEntityId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const counterentity = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const initialProofbodyHash = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const starterInitialArguments = '0x1234';
    const starterCounterArguments = '0xabcd';
    const finalizerRightArguments = '0xbeef';
    const watchSeed = `0x${'ee'.repeat(32)}`;
    const finalProofbody = makeProofBody(watchSeed);
    const finalProofbodyHash = proofBodyHashOf(finalProofbody);
    const starterCounterProofCommitment = keccak256(abiCoder.encode(
      ['uint256', 'bool', 'bytes32'],
      [2n, false, finalProofbodyHash],
    ));
    const disputeStartTimestamp = 90n;
    const initialArgumentsCommitment = keccak256(abiCoder.encode(
      ['bytes', 'bool', 'uint256'],
      [starterInitialArguments, true, disputeStartTimestamp],
    ));
    const counterArgumentsCommitment = keccak256(abiCoder.encode(
      ['bytes', 'bool', 'uint256'],
      [starterCounterArguments, true, disputeStartTimestamp],
    ));
    const disputeHash = encodeDisputeHash(
      1,
      true,
      true,
      100n,
      4n,
      6n,
      initialProofbodyHash,
      disputeStartTimestamp,
      starterInitialArguments,
      starterCounterArguments,
      starterCounterProofCommitment,
    );
    const queriedFromBlocks: number[] = [];
    const queriedToBlocks: number[] = [];
    const successfulLogRanges: Array<[number, number]> = [];
    let submittedFinalization: Record<string, unknown> | null = null;
    const tempRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-${Date.now()}`);
    tempRoots.push(tempRoot);
    await mkdir(tempRoot, { recursive: true });

    const store = createWatchtowerStore({
      towerId: 'tower-last-resort',
      dbPath: join(tempRoot, 'tower.level'),
      towerPrivateKey: towerWallet.privateKey,
    });

    const encryptedRemedy = await encryptTowerPayloadForWatchSeed(
      encodeTowerCounterDisputeRemedy({
        version: 1,
        type: 'counter_dispute_remedy',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
        watchedEntityId,
        towerAddress: towerWallet.address.toLowerCase(),
        lastResortWindowSeconds: 8,
        appointmentSequence: 5,
        ownerAuthorizationHanko: '0xbeef',
	        latestProof: {
	          counterentity,
	          finalNonce: 2,
	          proposerIsLeft: false,
	          finalProofbody,
	          leftArguments: '0x',
	          rightArguments: finalizerRightArguments,
	          sig: '0xcafe',
	        },
      }),
      watchSeed,
    );

    const appointment: TowerAppointmentV1 = {
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey,
      slot: 0,
      bundle: {
        version: 1,
        runtimeId: runtimeWallet.address.toLowerCase(),
        lookupKey,
        height: 42,
        createdAt: 1_717_171_717_000,
        bundleHash: keccak256(toUtf8Bytes('bundle:last-resort')),
        iv: '0x1234',
        ciphertext: '0xabcd',
      },
      lastResortPayload: {
        triggerHint: 'chain:31337:acct:test',
        encryptedRemedy,
        watch: {
          rpcUrl: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x1111111111111111111111111111111111111111',
          watchedEntityId,
          counterentity,
        },
        actionKind: 'counter_dispute_only',
        appointmentSequence: 5,
        proofNonce: 2,
        proofBodyHash: finalProofbodyHash,
        responseMode: 'last_resort',
        lastResortWindowSeconds: 8,
      },
      ownerProof: {
        runtimeId: runtimeWallet.address.toLowerCase(),
        signedAt: Date.now(),
        signature: '0xdead',
      },
    };
    await store.upsertAppointment(appointment);

    const result = await runWatchtowerSweep(store, {
      towerPrivateKey: towerWallet.privateKey,
      providerFactory: () => ({
        // The active start is 49,900 blocks old. A fixed recent-log window
        // would lose the signed dynamic arguments even though the 365-day
        // Account clock still makes the dispute actionable.
        getBlockNumber: async () => 50_000,
        getBlock: async (blockTag) => ({ timestamp: Number(blockTag) < 100 ? 89 : 95 }),
        getLogs: async (filter) => {
          const fromBlock = Number(filter['fromBlock']);
          const toBlock = Number(filter['toBlock']);
          queriedFromBlocks.push(fromBlock);
          queriedToBlocks.push(toBlock);
          if (toBlock - fromBlock + 1 > 5_000) {
            throw new Error('provider block range limit exceeded');
          }
          successfulLogRanges.push([fromBlock, toBlock]);
          if (fromBlock > 100 || toBlock < 100) return [];
          const event = disputeStartedInterface.encodeEventLog(
            disputeStartedInterface.getEvent('DisputeStarted'),
            [
              watchedEntityId,
              counterentity,
              1n,
              true,
              initialProofbodyHash,
              watchSeed,
              starterInitialArguments,
              starterCounterArguments,
              starterCounterProofCommitment,
              100n,
              disputeStartTimestamp,
              4,
              6,
            ],
          );
          return [{ topics: event.topics, data: event.data }];
        },
      }),
      contractFactory: () => ({
        accountKey: async () => '0xacc1',
        _accounts: async () => ({
          nonce: 1n,
          disputeHash,
          disputeTimeout: 100n,
          disputeStartTimestamp,
          leftResponseSeconds: 4n,
          rightResponseSeconds: 6n,
          disputeInitialProofbodyHash: initialProofbodyHash,
          disputeInitialProposerIsLeft: true,
          disputeCounterNonce: 0n,
          disputeCounterProofbodyHash: `0x${'00'.repeat(32)}`,
          disputeCounterProposerIsLeft: false,
          starterInitialArgumentsCommitment: initialArgumentsCommitment,
          starterCounterArgumentsCommitment: counterArgumentsCommitment,
          starterCounterProofCommitment,
          disputeStartedByLeft: true,
        }),
        watchtowerCounterDispute: async (_entityId, finalization) => {
          submittedFinalization = finalization as unknown as Record<string, unknown>;
          return {
            hash: '0xtxhash',
            wait: async () => ({ blockNumber: 96 }),
          };
        },
      }),
    });

    expect(result).toEqual({
      scanned: 1,
      submitted: 1,
      skipped: 0,
      errors: 0,
    });

    const receipts = await store.listActionReceipts(lookupKey);
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.status).toBe('submitted');
    expect(receipts[0]?.txHash).toBe('0xtxhash');
    expect(queriedFromBlocks.length).toBeGreaterThan(successfulLogRanges.length);
    expect(Math.max(...successfulLogRanges.map(([from, to]) => to - from + 1))).toBeLessThanOrEqual(5_000);
    expect(successfulLogRanges.some(([from, to]) => from <= 100 && to >= 100)).toBe(true);
    expect(submittedFinalization?.['starterArguments']).toBe(starterCounterArguments);
    expect(submittedFinalization?.['otherArguments']).toBe(finalizerRightArguments);
  });

  test('skips when dispute is inactive or still outside the last-resort window', async () => {
    const runtimeWallet = Wallet.createRandom();
    const towerWallet = Wallet.createRandom();
    const lookupKey = makeLookupKey('tower:last-resort:skip');
    const tempRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-skip-${Date.now()}`);
    tempRoots.push(tempRoot);
    await mkdir(tempRoot, { recursive: true });

    const store = createWatchtowerStore({
      towerId: 'tower-last-resort-skip',
      dbPath: join(tempRoot, 'tower.level'),
      towerPrivateKey: towerWallet.privateKey,
    });
    const watchSeed = `0x${'ee'.repeat(32)}`;
    const encryptedRemedy = await encryptTowerPayloadForWatchSeed(
      encodeTowerCounterDisputeRemedy({
        version: 1,
        type: 'counter_dispute_remedy',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
        watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        towerAddress: towerWallet.address.toLowerCase(),
        lastResortWindowSeconds: 8,
        appointmentSequence: 9,
        ownerAuthorizationHanko: '0xbeef',
        latestProof: {
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          finalNonce: 2,
          proposerIsLeft: false,
          finalProofbody: makeProofBody(watchSeed),
          leftArguments: '0x',
          rightArguments: '0x',
          sig: '0xcafe',
        },
      }),
      watchSeed,
    );

    await store.upsertAppointment({
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey,
      slot: 0,
      bundle: {
        version: 1,
        runtimeId: runtimeWallet.address.toLowerCase(),
        lookupKey,
        height: 7,
        createdAt: 1_717_171_718_000,
        bundleHash: keccak256(toUtf8Bytes('bundle:skip')),
        iv: '0x1234',
        ciphertext: '0xabcd',
      },
      lastResortPayload: {
        triggerHint: 'chain:31337:acct:skip',
        encryptedRemedy,
        watch: {
          rpcUrl: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x1111111111111111111111111111111111111111',
          watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        actionKind: 'counter_dispute_only',
        appointmentSequence: 9,
        proofNonce: 2,
        proofBodyHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        responseMode: 'last_resort',
        lastResortWindowSeconds: 8,
      },
      ownerProof: {
        runtimeId: runtimeWallet.address.toLowerCase(),
        signedAt: Date.now(),
        signature: '0xdead',
      },
    });

    const result = await runWatchtowerSweep(store, {
      towerPrivateKey: towerWallet.privateKey,
      providerFactory: () => ({
        getBlockNumber: async () => 10,
        getBlock: async () => ({ timestamp: 10 }),
        getLogs: async () => [],
      }),
      contractFactory: () => ({
        accountKey: async () => '0xacc2',
        _accounts: async () => ({
          nonce: 1n,
          disputeHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
          disputeTimeout: 100n,
          disputeStartTimestamp: 1n,
          leftResponseSeconds: 4n,
          rightResponseSeconds: 6n,
          disputeInitialProofbodyHash: `0x${'88'.repeat(32)}`,
          disputeInitialProposerIsLeft: true,
          disputeCounterNonce: 0n,
          disputeCounterProofbodyHash: `0x${'00'.repeat(32)}`,
          disputeCounterProposerIsLeft: false,
          starterInitialArgumentsCommitment: `0x${'77'.repeat(32)}`,
          starterCounterArgumentsCommitment: `0x${'66'.repeat(32)}`,
          starterCounterProofCommitment: emptyCounterProofCommitment,
          disputeStartedByLeft: true,
        }),
        watchtowerCounterDispute: async () => {
          throw new Error('should not be called');
        },
      }),
    });

    expect(result).toEqual({
      scanned: 1,
      submitted: 0,
      skipped: 1,
      errors: 0,
    });

    const receipts = await store.listActionReceipts(lookupKey);
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.status).toBe('skipped');
  });

  test('rejects appointment RPC URLs outside the tower allowlist during sweep', async () => {
    const runtimeWallet = Wallet.createRandom();
    const towerWallet = Wallet.createRandom();
    const lookupKey = makeLookupKey('tower:last-resort:ssrf');
    const tempRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-ssrf-${Date.now()}`);
    tempRoots.push(tempRoot);
    await mkdir(tempRoot, { recursive: true });

    const store = createWatchtowerStore({
      towerId: 'tower-last-resort-ssrf',
      dbPath: join(tempRoot, 'tower.level'),
      towerPrivateKey: towerWallet.privateKey,
    });
    const watchSeed = `0x${'ee'.repeat(32)}`;
    const encryptedRemedy = await encryptTowerPayloadForWatchSeed(
      encodeTowerCounterDisputeRemedy({
        version: 1,
        type: 'counter_dispute_remedy',
        rpcUrl: 'http://169.254.169.254/latest/meta-data',
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
        watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        towerAddress: towerWallet.address.toLowerCase(),
        lastResortWindowSeconds: 8,
        appointmentSequence: 10,
        ownerAuthorizationHanko: '0xbeef',
        latestProof: {
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          finalNonce: 2,
          proposerIsLeft: false,
          finalProofbody: makeProofBody(watchSeed),
          leftArguments: '0x',
          rightArguments: '0x',
          sig: '0xcafe',
        },
      }),
      watchSeed,
    );

    await store.upsertAppointment({
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey,
      slot: 0,
      bundle: {
        version: 1,
        runtimeId: runtimeWallet.address.toLowerCase(),
        lookupKey,
        height: 8,
        createdAt: 1_717_171_719_000,
        bundleHash: keccak256(toUtf8Bytes('bundle:ssrf')),
        iv: '0x1234',
        ciphertext: '0xabcd',
      },
      lastResortPayload: {
        triggerHint: 'chain:31337:acct:ssrf',
        encryptedRemedy,
        watch: {
          rpcUrl: 'http://169.254.169.254/latest/meta-data',
          chainId: 31337,
          depositoryAddress: '0x1111111111111111111111111111111111111111',
          watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        actionKind: 'counter_dispute_only',
        appointmentSequence: 10,
        proofNonce: 2,
        proofBodyHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        responseMode: 'last_resort',
        lastResortWindowSeconds: 8,
      },
      ownerProof: {
        runtimeId: runtimeWallet.address.toLowerCase(),
        signedAt: Date.now(),
        signature: '0xdead',
      },
    });

    const result = await runWatchtowerSweep(store, {
      towerPrivateKey: towerWallet.privateKey,
      allowedRpcUrls: ['http://127.0.0.1:8545/'],
    });

    expect(result).toEqual({
      scanned: 1,
      submitted: 0,
      skipped: 0,
      errors: 1,
    });
    const receipts = await store.listActionReceipts(lookupKey);
    expect(receipts[0]?.status).toBe('error');
    expect(receipts[0]?.error).toContain('WATCHTOWER_RPC_URL_NOT_ALLOWED');
  });

  test('rejects stale last-resort appointment metadata after breach reveal before tx', async () => {
    const runtimeWallet = Wallet.createRandom();
    const towerWallet = Wallet.createRandom();
    const lookupKey = makeLookupKey('tower:last-resort:mismatch');
    const tempRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-mismatch-${Date.now()}`);
    tempRoots.push(tempRoot);
    await mkdir(tempRoot, { recursive: true });

    const store = createWatchtowerStore({
      towerId: 'tower-last-resort-mismatch',
      dbPath: join(tempRoot, 'tower.level'),
      towerPrivateKey: towerWallet.privateKey,
    });

    const watchSeed = `0x${'ef'.repeat(32)}`;
    const remedyProofbody = makeProofBody(watchSeed);
    const encryptedRemedy = await encryptTowerPayloadForWatchSeed(
      encodeTowerCounterDisputeRemedy({
        version: 1,
        type: 'counter_dispute_remedy',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
        watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        towerAddress: towerWallet.address.toLowerCase(),
        lastResortWindowSeconds: 8,
        appointmentSequence: 12,
        ownerAuthorizationHanko: '0xbeef',
        latestProof: {
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          finalNonce: 6,
          proposerIsLeft: false,
          finalProofbody: remedyProofbody,
          leftArguments: '0x',
          rightArguments: '0x',
          sig: '0xcafe',
        },
      }),
      watchSeed,
    );
    const initialProofbodyHash = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const disputeStartTimestamp = 90n;
    const emptyArgumentsCommitment = keccak256(abiCoder.encode(
      ['bytes', 'bool', 'uint256'],
      ['0x', true, disputeStartTimestamp],
    ));
    const disputeHash = encodeDisputeHash(
      1,
      true,
      true,
      100n,
      4n,
      6n,
      initialProofbodyHash,
      disputeStartTimestamp,
      '0x',
      '0x',
    );

    await store.upsertAppointment({
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey,
      slot: 0,
      bundle: {
        version: 1,
        runtimeId: runtimeWallet.address.toLowerCase(),
        lookupKey,
        height: 9,
        createdAt: 1_717_171_720_000,
        bundleHash: keccak256(toUtf8Bytes('bundle:mismatch')),
        iv: '0x1234',
        ciphertext: '0xabcd',
      },
      lastResortPayload: {
        triggerHint: 'chain:31337:acct:mismatch',
        encryptedRemedy,
        watch: {
          rpcUrl: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x1111111111111111111111111111111111111111',
          watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        actionKind: 'counter_dispute_only',
        appointmentSequence: 11,
        proofNonce: 6,
        proofBodyHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        responseMode: 'last_resort',
        lastResortWindowSeconds: 8,
      },
      ownerProof: {
        runtimeId: runtimeWallet.address.toLowerCase(),
        signedAt: Date.now(),
        signature: '0xdead',
      },
    });

    const result = await runWatchtowerSweep(store, {
      towerPrivateKey: towerWallet.privateKey,
      providerFactory: () => ({
        getBlockNumber: async () => 95,
        getBlock: async () => ({ timestamp: 95 }),
        getLogs: async () => {
          const event = disputeStartedInterface.encodeEventLog(
            disputeStartedInterface.getEvent('DisputeStarted'),
            [
              '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              1n,
              true,
              initialProofbodyHash,
              watchSeed,
              '0x',
              '0x',
              emptyCounterProofCommitment,
              100n,
              disputeStartTimestamp,
              4,
              6,
            ],
          );
          return [{ topics: event.topics, data: event.data }];
        },
      }),
      contractFactory: () => ({
        accountKey: async () => '0xacc3',
        _accounts: async () => ({
          nonce: 1n,
          disputeHash,
          disputeTimeout: 100n,
          disputeStartTimestamp,
          leftResponseSeconds: 4n,
          rightResponseSeconds: 6n,
          disputeInitialProofbodyHash: initialProofbodyHash,
          disputeInitialProposerIsLeft: true,
          disputeCounterNonce: 0n,
          disputeCounterProofbodyHash: `0x${'00'.repeat(32)}`,
          disputeCounterProposerIsLeft: false,
          starterInitialArgumentsCommitment: emptyArgumentsCommitment,
          starterCounterArgumentsCommitment: emptyArgumentsCommitment,
          starterCounterProofCommitment: emptyCounterProofCommitment,
          disputeStartedByLeft: true,
        }),
        watchtowerCounterDispute: async () => {
          throw new Error('tx must not be submitted');
        },
      }),
    });

    expect(result).toEqual({
      scanned: 1,
      submitted: 0,
      skipped: 0,
      errors: 1,
    });
    const receipts = await store.listActionReceipts(lookupKey);
    expect(receipts[0]?.status).toBe('error');
    expect(receipts[0]?.error).toContain('WATCHTOWER_APPOINTMENT_SEQUENCE_MISMATCH');
  });

  test('selects latest last-resort appointment by appointment sequence before bundle height', async () => {
    const runtimeWallet = Wallet.createRandom();
    const lookupKey = makeLookupKey('tower:last-resort:sequence-order');
    const tempRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-sequence-${Date.now()}`);
    tempRoots.push(tempRoot);
    await mkdir(tempRoot, { recursive: true });

    const store = createWatchtowerStore({
      towerId: 'tower-last-resort-sequence',
      dbPath: join(tempRoot, 'tower.level'),
    });
    const encryptedRemedy = await encryptTowerPayloadForWatchSeed(
      encodeTowerCounterDisputeRemedy({
        version: 1,
        type: 'counter_dispute_remedy',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
        watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        towerAddress: Wallet.createRandom().address.toLowerCase(),
        lastResortWindowSeconds: 8,
        appointmentSequence: 4,
        ownerAuthorizationHanko: '0xbeef',
        latestProof: {
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          finalNonce: 4,
          proposerIsLeft: false,
          finalProofbody: makeProofBody(`0x${'ee'.repeat(32)}`),
          leftArguments: '0x',
          rightArguments: '0x',
          sig: '0xcafe',
        },
      }),
      `0x${'ee'.repeat(32)}`,
    );

    const baseAppointment = {
      type: 'tower_appointment' as const,
      version: 1 as const,
      towerMode: 'delayed_last_resort' as const,
      lookupKey,
      slot: 0,
      bundle: {
        version: 1 as const,
        runtimeId: runtimeWallet.address.toLowerCase(),
        lookupKey,
        height: 10,
        createdAt: 1_717_171_721_000,
        bundleHash: keccak256(toUtf8Bytes('bundle:sequence:base')),
        iv: '0x1234',
        ciphertext: '0xabcd',
      },
      lastResortPayload: {
        triggerHint: 'chain:31337:acct:sequence',
        encryptedRemedy,
        watch: {
          rpcUrl: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x1111111111111111111111111111111111111111',
          watchedEntityId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        actionKind: 'counter_dispute_only' as const,
        appointmentSequence: 4,
        proofNonce: 4,
        proofBodyHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        responseMode: 'last_resort' as const,
        lastResortWindowSeconds: 8,
      },
      ownerProof: {
        runtimeId: runtimeWallet.address.toLowerCase(),
        signedAt: Date.now(),
        signature: '0xdead',
      },
    };

    await store.upsertAppointment({
      ...baseAppointment,
      bundle: {
        ...baseAppointment.bundle,
        height: 999,
        bundleHash: keccak256(toUtf8Bytes('bundle:sequence:old-high-height')),
      },
      lastResortPayload: {
        ...baseAppointment.lastResortPayload,
        appointmentSequence: 3,
        proofNonce: 3,
      },
    });
    await store.upsertAppointment({
      ...baseAppointment,
      bundle: {
        ...baseAppointment.bundle,
        height: 11,
        bundleHash: keccak256(toUtf8Bytes('bundle:sequence:new-sequence')),
      },
      lastResortPayload: {
        ...baseAppointment.lastResortPayload,
        appointmentSequence: 5,
        proofNonce: 5,
      },
    });

    const [latest] = await store.listLatestLastResortAppointments();
    expect(latest?.lastResortPayload.appointmentSequence).toBe(5);
    expect(latest?.bundle.height).toBe(11);
  });
});
