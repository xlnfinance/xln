import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AbiCoder, Interface, ParamType, Wallet, keccak256, solidityPacked, toUtf8Bytes } from 'ethers';
import { createWatchtowerStore } from '../watchtower/store';
import { assertWatchtowerRpcUrlAllowed, encodeTowerCounterDisputeRemedy, runWatchtowerSweep } from '../watchtower/action';
import { encryptTowerPayloadForWatchSeed } from '../recovery/crypto';
import type { TowerAppointmentV1 } from '../recovery/types';

const makeLookupKey = (label: string): string => keccak256(toUtf8Bytes(label));
const disputeStartedInterface = new Interface([
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterIncrementedArguments)',
]);
const abiCoder = AbiCoder.defaultAbiCoder();
const proofBodyParam = ParamType.from(
  'tuple(bytes32 watchSeed,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)',
);
const makeProofBody = (watchSeed: string, offdeltas: bigint[] = [-1n]): Record<string, unknown> => ({
  watchSeed,
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
  disputeTimeout: bigint,
  initialProofbodyHash: string,
  starterInitialArguments: string,
  starterIncrementedArguments: string,
): string => keccak256(
  solidityPacked(
    ['uint256', 'bool', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
    [
      BigInt(initialNonce),
      startedByLeft,
      disputeTimeout,
      initialProofbodyHash,
      keccak256(starterInitialArguments),
      keccak256(starterIncrementedArguments),
    ],
  ),
);

describe('watchtower delayed last-resort sweep', () => {
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
          lastResortWindowBlocks: 8,
          appointmentSequence: 1,
          ownerAuthorizationHanko: '0xbeef',
          latestProof: {
            counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            finalNonce: 2,
            finalProofbody: makeProofBody(`0x${'ee'.repeat(32)}`),
            leftArguments: '0x',
            rightArguments: '0x',
            starterIncrementedArguments: '0x',
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
        lastResortWindowBlocks: 8,
        safetyMarginBlocks: 2,
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
    const starterIncrementedArguments = '0xabcd';
    const finalizerRightArguments = '0xbeef';
    const watchSeed = `0x${'ee'.repeat(32)}`;
    const finalProofbody = makeProofBody(watchSeed);
    const finalProofbodyHash = proofBodyHashOf(finalProofbody);
    const disputeHash = encodeDisputeHash(1, true, 100n, initialProofbodyHash, starterInitialArguments, starterIncrementedArguments);
    const queriedFromBlocks: number[] = [];
    const queriedToBlocks: number[] = [];
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
        lastResortWindowBlocks: 8,
        appointmentSequence: 5,
        ownerAuthorizationHanko: '0xbeef',
	        latestProof: {
	          counterentity,
	          finalNonce: 2,
	          finalProofbody,
	          leftArguments: '0x',
	          rightArguments: finalizerRightArguments,
	          starterIncrementedArguments,
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
        lastResortWindowBlocks: 8,
        safetyMarginBlocks: 2,
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
        getBlockNumber: async () => 95,
        getLogs: async (filter) => {
          queriedFromBlocks.push(Number(filter['fromBlock']));
          queriedToBlocks.push(Number(filter['toBlock']));
          const event = disputeStartedInterface.encodeEventLog(
            disputeStartedInterface.getEvent('DisputeStarted'),
            [
              watchedEntityId,
              counterentity,
              1n,
              initialProofbodyHash,
              watchSeed,
              starterInitialArguments,
              starterIncrementedArguments,
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
        }),
        defaultDisputeDelay: async () => 95n,
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
	    expect(queriedFromBlocks).toEqual([5, 5]);
	    expect(queriedToBlocks).toEqual([95, 95]);
	    expect(submittedFinalization?.['leftArguments']).toBe(starterIncrementedArguments);
	    expect(submittedFinalization?.['rightArguments']).toBe(finalizerRightArguments);
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
        lastResortWindowBlocks: 8,
        appointmentSequence: 9,
        ownerAuthorizationHanko: '0xbeef',
        latestProof: {
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          finalNonce: 2,
          finalProofbody: makeProofBody(watchSeed),
          leftArguments: '0x',
          rightArguments: '0x',
          starterIncrementedArguments: '0x',
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
        lastResortWindowBlocks: 8,
        safetyMarginBlocks: 2,
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
        getLogs: async () => [],
      }),
      contractFactory: () => ({
        accountKey: async () => '0xacc2',
        _accounts: async () => ({
          nonce: 1n,
          disputeHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
          disputeTimeout: 100n,
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
        lastResortWindowBlocks: 8,
        appointmentSequence: 10,
        ownerAuthorizationHanko: '0xbeef',
        latestProof: {
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          finalNonce: 2,
          finalProofbody: makeProofBody(watchSeed),
          leftArguments: '0x',
          rightArguments: '0x',
          starterIncrementedArguments: '0x',
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
        lastResortWindowBlocks: 8,
        safetyMarginBlocks: 2,
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
        lastResortWindowBlocks: 8,
        appointmentSequence: 12,
        ownerAuthorizationHanko: '0xbeef',
        latestProof: {
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          finalNonce: 6,
          finalProofbody: remedyProofbody,
          leftArguments: '0x',
          rightArguments: '0x',
          starterIncrementedArguments: '0x',
          sig: '0xcafe',
        },
      }),
      watchSeed,
    );
    const initialProofbodyHash = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const disputeHash = encodeDisputeHash(1, true, 100n, initialProofbodyHash, '0x', '0x');

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
        lastResortWindowBlocks: 8,
        safetyMarginBlocks: 2,
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
        getLogs: async () => {
          const event = disputeStartedInterface.encodeEventLog(
            disputeStartedInterface.getEvent('DisputeStarted'),
            [
              '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              1n,
              initialProofbodyHash,
              watchSeed,
              '0x',
              '0x',
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
        lastResortWindowBlocks: 8,
        appointmentSequence: 4,
        ownerAuthorizationHanko: '0xbeef',
        latestProof: {
          counterentity: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          finalNonce: 4,
          finalProofbody: makeProofBody(`0x${'ee'.repeat(32)}`),
          leftArguments: '0x',
          rightArguments: '0x',
          starterIncrementedArguments: '0x',
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
        lastResortWindowBlocks: 8,
        safetyMarginBlocks: 2,
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
