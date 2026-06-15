import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Interface, Wallet, keccak256, solidityPacked, toUtf8Bytes } from 'ethers';
import { createWatchtowerStore } from '../watchtower/store';
import { assertWatchtowerRpcUrlAllowed, encodeTowerCounterDisputeRemedy, runWatchtowerSweep } from '../watchtower/action';
import { encryptTowerPayloadForPublicKey, getTowerPayloadEncryptionPublicKey } from '../recovery/crypto';
import type { TowerAppointmentV1 } from '../recovery/types';

const makeLookupKey = (label: string): string => keccak256(toUtf8Bytes(label));
const disputeStartedInterface = new Interface([
  'event DisputeStartedV2(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes starterInitialArguments, bytes starterIncrementedArguments)',
]);

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

    const encryptedRemedy = await encryptTowerPayloadForPublicKey(
      encodeTowerCounterDisputeRemedy({
        version: 2,
        type: 'counter_dispute_remedy',
        rpcUrl: 'mock://watchtower',
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
	          finalProofbody: { offdeltas: [-1], tokenIds: [1], transformers: [] },
	          leftArguments: '0x',
	          rightArguments: finalizerRightArguments,
	          starterIncrementedArguments,
	          sig: '0xcafe',
	        },
      }),
      getTowerPayloadEncryptionPublicKey(towerWallet.privateKey),
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
      activePayload: {
        triggerHint: 'chain:31337:acct:test',
        encryptedRemedy,
        actionKind: 'counter_dispute_only',
        appointmentSequence: 5,
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
            disputeStartedInterface.getEvent('DisputeStartedV2'),
            [
              watchedEntityId,
              counterentity,
              1n,
              initialProofbodyHash,
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
      activePayload: {
        triggerHint: 'chain:31337:acct:skip',
        encryptedRemedy: encodeTowerCounterDisputeRemedy({
          version: 2,
          type: 'counter_dispute_remedy',
          rpcUrl: 'mock://watchtower',
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
            finalProofbody: { offdeltas: [-1], tokenIds: [1], transformers: [] },
            leftArguments: '0x',
            rightArguments: '0x',
            starterIncrementedArguments: '0x',
            sig: '0xcafe',
          },
        }),
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
      activePayload: {
        triggerHint: 'chain:31337:acct:ssrf',
        encryptedRemedy: encodeTowerCounterDisputeRemedy({
          version: 2,
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
            finalProofbody: { offdeltas: [-1], tokenIds: [1], transformers: [] },
            leftArguments: '0x',
            rightArguments: '0x',
            starterIncrementedArguments: '0x',
            sig: '0xcafe',
          },
        }),
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

  test('rejects stale active appointment metadata before touching RPC', async () => {
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

    const encryptedRemedy = await encryptTowerPayloadForPublicKey(
      encodeTowerCounterDisputeRemedy({
        version: 2,
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
          finalProofbody: { offdeltas: [-1], tokenIds: [1], transformers: [] },
          leftArguments: '0x',
          rightArguments: '0x',
          starterIncrementedArguments: '0x',
          sig: '0xcafe',
        },
      }),
      getTowerPayloadEncryptionPublicKey(towerWallet.privateKey),
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
      activePayload: {
        triggerHint: 'chain:31337:acct:mismatch',
        encryptedRemedy,
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
      providerFactory: () => {
        throw new Error('provider must not be created');
      },
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

  test('selects latest active appointment by appointment sequence before bundle height', async () => {
    const runtimeWallet = Wallet.createRandom();
    const lookupKey = makeLookupKey('tower:last-resort:sequence-order');
    const tempRoot = join(process.cwd(), '.tmp-tests', `tower-last-resort-sequence-${Date.now()}`);
    tempRoots.push(tempRoot);
    await mkdir(tempRoot, { recursive: true });

    const store = createWatchtowerStore({
      towerId: 'tower-last-resort-sequence',
      dbPath: join(tempRoot, 'tower.level'),
    });

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
      activePayload: {
        triggerHint: 'chain:31337:acct:sequence',
        encryptedRemedy: '{}',
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
      activePayload: {
        ...baseAppointment.activePayload,
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
      activePayload: {
        ...baseAppointment.activePayload,
        appointmentSequence: 5,
        proofNonce: 5,
      },
    });

    const [latest] = await store.listLatestActiveAppointments();
    expect(latest?.activePayload.appointmentSequence).toBe(5);
    expect(latest?.bundle.height).toBe(11);
  });
});
