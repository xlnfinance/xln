import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { decodeJEventLog, parseReceiptLogsToJEvents } from '../../../jurisdiction/adapter/j-event-log-decoder';
import { resolveDisputeLogReferences } from '../../../jurisdiction/adapter/events/dispute/log-reference';
import { PROOF_BODY_ABI } from '../../../protocol/dispute/proof-body';
import { decodeAuthenticatedWatcherEvents } from '../../../jurisdiction/adapter/rpc-watcher-events';
import { isRpcWatcherTransientError } from '../../../jurisdiction/adapter/rpc/rpc-adapter';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';
import { createTestJReplica } from '../../helpers/j-replica';
import { createJurisdictionConfig } from '../../../scenarios/harness/boot';
import { safeParse, safeStringify } from '../../../protocol/serialization';

const word = (byte: string) => `0x${byte.repeat(32)}`;
const coder = ethers.AbiCoder.defaultAbiCoder();
const iface = Depository__factory.createInterface();
const body = {
  watchSeed: word('44'), leftResponseSeconds: 10, rightResponseSeconds: 10,
  offdeltas: [{ high: -1n, low: ethers.MaxUint256 - 4n }], tokenIds: [1n],
  transformers: [{ transformerAddress: `0x${'33'.repeat(20)}`, encodedBatch: '0x1234',
    allowances: [{ deltaIndex: 0n, rightAllowance: 3n, leftAllowance: 4n }] }],
};
const encodedBody = coder.encode([PROOF_BODY_ABI], [body]);
const hash = ethers.keccak256(encodedBody);
const coordinates = { blockNumber: 42, blockHash: word('88'), transactionHash: word('99'), logIndex: 0 };
const decode = (name: string, values: unknown[]) => decodeJEventLog(
  iface.encodeEventLog(name, values), iface, coordinates, 'TEST_EVENT_DECODE',
);
const start = [word('11'), word('22'), 7n, false, hash, body.watchSeed,
  '0x', '0x', ethers.ZeroHash, 120n, 100n, 10n, 10n, encodedBody];
const counter = [word('11'), word('22'), 11n, false, hash, encodedBody];
const finalization = {
  initialProofbodyHash: word('55'), finalNonce: 11n, proposerIsLeft: false,
  startedByLeft: true, starterArgumentsHash: ethers.keccak256('0x'), otherArguments: '0xabcd', sig: '0x',
};
const evidenceHash = ethers.keccak256(coder.encode(
  ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
  [finalization.initialProofbodyHash, 11n, false, true,
    ethers.keccak256('0x'), ethers.keccak256('0xabcd'), ethers.keccak256('0x')],
));
const finalized = [word('11'), word('22'), 7n, hash, evidenceHash, encodedBody, finalization];

test('all dispute log shapes carry cloneable exact proof bodies without transaction I/O', () => {
  for (const [name, values, field] of [
    ['DisputeStarted', start, 'initialProofbody'],
    ['CounterDisputeRegistered', counter, 'counterProofbody'],
    ['DisputeFinalized', finalized, 'finalProofbody'],
  ] as const) {
    expect(structuredClone(decode(name, values).args[field])).toEqual(body);
  }
});

test('every dispute event rejects a body that does not match its hash', () => {
  for (const [name, values, hashIndex] of [
    ['DisputeStarted', start, 4], ['CounterDisputeRegistered', counter, 4], ['DisputeFinalized', finalized, 3],
  ] as const) {
    const forged = [...values];
    forged[hashIndex] = ethers.ZeroHash;
    expect(() => decode(name, forged)).toThrow('J_DISPUTE_EVENT_PROOFBODY_HASH_MISMATCH');
  }
});

test('finalization verifies its sidecar and preserves the effective watchtower signature', () => {
  const event = decode('DisputeFinalized', finalized);
  expect(event.args['initialProofbodyHash']).toBe(finalization.initialProofbodyHash);
  expect(event.disputeFinalizationEvidence).toEqual({
    sender: word('11'), counterentity: word('22'), initialNonce: '7', finalNonce: '11',
    initialProofbodyHash: finalization.initialProofbodyHash, finalProofbodyHash: hash,
    proposerIsLeft: false, startedByLeft: true, leftArguments: '0x', rightArguments: '0xabcd', sig: '0x',
  });
  for (const change of [{ sig: '0x0102' }, { otherArguments: '0xdead' }, { finalNonce: 12n },
    { initialProofbodyHash: ethers.ZeroHash }, { proposerIsLeft: true }, { startedByLeft: false }]) {
    expect(() => decode('DisputeFinalized', [...finalized.slice(0, -1), { ...finalization, ...change }]))
      .toThrow('J_DISPUTE_EVENT_FINALIZATION_HASH_MISMATCH');
  }
});

test('hash-valid noncanonical proof bytes are rejected', () => {
  const padded = `${encodedBody}00`.toLowerCase();
  expect(() => decode('CounterDisputeRegistered', [word('11'), word('22'), 11n, false,
    ethers.keccak256(padded), padded])).toThrow('J_DISPUTE_EVENT_PROOFBODY_NONCANONICAL');
});

test('a start log must bind its seed and response clocks to the signed body', () => {
  for (const [index, value] of [[5, ethers.ZeroHash], [11, 11n], [12, 11n]] as const) {
    const forged = [...start];
    forged[index] = value;
    expect(() => decode('DisputeStarted', forged)).toThrow('J_DISPUTE_EVENT_START_BINDING_MISMATCH');
  }
});

test('retired hash-only dispute events from a configured carrier are rejected loudly', () => {
  for (const topic of [
    '0xb3a65f8a2fc99051b8235a54207bb2434556eb7682695e9374cf539c9ba453a7',
    '0x6d46d52b5fda2a9055705ba74bf5e95807cfa39decf819cdfeaa14f9b2ba346a',
    '0xdf1d21d89097ae482123e351724eb4c07eb3b9319a0e116643d815958aea1609',
  ]) {
    expect(() => parseReceiptLogsToJEvents({
      ...coordinates, hash: coordinates.transactionHash,
      logs: [{ address: ethers.ZeroAddress, topics: [topic], data: '0x', index: 0 }],
    }, [{ address: ethers.ZeroAddress, interface: iface }])).toThrow('J_RECEIPT_RETIRED_MONEY_ABI');
  }
});

const reference = (name: string, values: unknown[], blockNumber = 41, index = 0) => ({
  ...iface.encodeEventLog(name, values), blockNumber, index,
});

test('hash-only finalization resolves its exact body from an earlier start, across polls/restart', async () => {
  const event = decode('DisputeFinalized', [...finalized.slice(0, 5), '0x', finalization]);
  const resolved = await resolveDisputeLogReferences(event, async () => [reference('DisputeStarted', start)]);
  expect(resolved.args['finalProofbody']).toEqual(body);
  expect(resolved.disputeFinalizationEvidence?.finalProofbodyHash).toBe(hash);
  await expect(resolveDisputeLogReferences(event, async () => [])).rejects.toThrow('PROOFBODY_LOG_MISSING');
  await expect(resolveDisputeLogReferences(event, async () => [reference('DisputeStarted', start, 43)]))
    .rejects.toThrow('PROOFBODY_LOG_MISSING');
});

test('hash-only finalization resolves a counter body and rejects wrong-pair/malformed sources', async () => {
  const event = decode('DisputeFinalized', [...finalized.slice(0, 5), '0x', finalization]);
  expect((await resolveDisputeLogReferences(event, async () => [reference('CounterDisputeRegistered', counter)]))
    .args['finalProofbody']).toEqual(body);
  const wrong = [...counter]; wrong[0] = word('33');
  await expect(resolveDisputeLogReferences(event, async () => [reference('CounterDisputeRegistered', wrong)]))
    .rejects.toThrow('PROOFBODY_LOG_MISSING');
  const corrupt = [...counter]; corrupt[5] = '0x1234';
  await expect(resolveDisputeLogReferences(event, async () => [reference('CounterDisputeRegistered', corrupt)]))
    .rejects.toThrow('PROOFBODY_HASH_MISMATCH');
});

test('large starter arguments are resolved by hash from the matching initial log', async () => {
  const argumentsBytes = `0x${'ab'.repeat(65536)}`;
  const fields = { ...finalization, initialProofbodyHash: hash, starterArgumentsHash: ethers.keccak256(argumentsBytes) };
  const commitment = ethers.keccak256(coder.encode(
    ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
    [hash, 11n, false, true, fields.starterArgumentsHash, ethers.keccak256('0xabcd'), ethers.keccak256('0x')],
  ));
  const event = decode('DisputeFinalized', [word('11'), word('22'), 7n, hash, commitment, '0x', fields]);
  const earlier = [...start]; earlier[6] = argumentsBytes;
  const resolved = await resolveDisputeLogReferences(event, async () => [reference('DisputeStarted', earlier)]);
  expect(resolved.disputeFinalizationEvidence?.leftArguments).toBe(argumentsBytes);
  earlier[2] = 8n;
  await expect(resolveDisputeLogReferences(event, async () => [reference('DisputeStarted', earlier)]))
    .rejects.toThrow('STARTER_ARGUMENTS_MISSING');
});


test('a counter reusing an earlier body resolves its hash without re-emitting bytes', async () => {
  const event = decode('CounterDisputeRegistered', [word('11'), word('22'), 12n, false, hash, '0x']);
  const resolved = await resolveDisputeLogReferences(event, async () => [reference('CounterDisputeRegistered', counter)]);
  expect(resolved.args['counterProofbody']).toEqual(body);
  await expect(resolveDisputeLogReferences(event, async () => [])).rejects.toThrow('PROOFBODY_LOG_MISSING');
});

const watcherInput = () => {
  const { env, replica } = createEntityProposalFixture('dispute-audience', 1n, ['1']).createValidator('1');
  env.state.eReplicas.set(`${replica.entityId}:${replica.signerId}`, replica);
  const depositoryAddress = `0x${'aa'.repeat(20)}`;
  const entityProviderAddress = `0x${'bb'.repeat(20)}`;
  const watcherReplica = createTestJReplica({ name: 'disputes', chainId: 31337,
    contracts: { depository: depositoryAddress, entityProvider: entityProviderAddress } });
  env.state.jReplicas.set(watcherReplica.name, watcherReplica);
  replica.state.config.jurisdiction = createJurisdictionConfig(watcherReplica.name,
    depositoryAddress, entityProviderAddress, 'http://127.0.0.1:8545', 31337);
  return { env, replica, watcherReplica, depositoryAddress, entityProviderAddress,
    tokenByAddress: new Map(), trackedOwners: new Map(), observedThroughHeight: 42,
    observedTipBlockHash: coordinates.blockHash, observedHeadHeight: 42, confirmationDepth: 0 };
};
const watcherLog = (address: string, name: string, values: unknown[], index = 0) => ({
  ...iface.encodeEventLog(name, values), address, ...coordinates, index,
});

test('watcher ignores foreign-pair dispute start, counter and finalization without reading references', async () => {
  const input = watcherInput();
  let reads = 0;
  const result = await decodeAuthenticatedWatcherEvents({ ...input,
    logs: [watcherLog(input.depositoryAddress, 'DisputeStarted', start),
      watcherLog(input.depositoryAddress, 'CounterDisputeRegistered', [...counter.slice(0, 5), '0x'], 1),
      watcherLog(input.depositoryAddress, 'DisputeFinalized', [...finalized.slice(0, 5), '0x', finalization], 2)],
    readDisputeReferenceLogs: async () => { reads += 1; throw new Error('FOREIGN_PAIR_MUST_NOT_FETCH'); },
  });
  expect(reads).toBe(0);
  expect(result.events).toEqual([]);
});

test('served-pair missing proof body and reference RPC errors are retryable through decode wrapping', async () => {
  for (const readLogs of [async () => [], async () => { throw new Error('RPC_LOG_HISTORY_UNAVAILABLE'); }]) {
    const input = watcherInput();
    const values = [input.replica.entityId, word('22'), 8n, false, hash, '0x'];
    const error = await decodeAuthenticatedWatcherEvents({ ...input,
      logs: [watcherLog(input.depositoryAddress, 'CounterDisputeRegistered', values)],
      readDisputeReferenceLogs: readLogs,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(isRpcWatcherTransientError(error)).toBe(true);
  }
});

test('served-pair missing starter arguments are retryable while invalid evidence stays fatal', async () => {
  const input = watcherInput();
  const fields = { ...finalization, starterArgumentsHash: ethers.keccak256('0x1234') };
  const commitment = ethers.keccak256(coder.encode(
    ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
    [fields.initialProofbodyHash, 11n, false, true, fields.starterArgumentsHash,
      ethers.keccak256(fields.otherArguments), ethers.keccak256(fields.sig)],
  ));
  const values = [input.replica.entityId, word('22'), 7n, hash, commitment, encodedBody, fields];
  const run = (values: unknown[]) => decodeAuthenticatedWatcherEvents({ ...input,
    logs: [watcherLog(input.depositoryAddress, 'DisputeFinalized', values)],
    readDisputeReferenceLogs: async () => [],
  }).catch((error: unknown) => error);
  const missing = await run(values);
  expect(String(missing)).toContain('START_BLOCK_MISSING');
  expect(isRpcWatcherTransientError(missing)).toBe(true);
  values[4] = ethers.ZeroHash;
  const corrupt = await run(values);
  expect(String(corrupt)).toContain('FINALIZATION_HASH_MISMATCH');
  expect(isRpcWatcherTransientError(corrupt)).toBe(false);
});

test('only B served retains A receipt nonce for its dispute against B', async () => {
  const input = watcherInput();
  const values = [...start]; values[1] = input.replica.entityId;
  const decoded = await decodeAuthenticatedWatcherEvents({ ...input, logs: [
    watcherLog(input.depositoryAddress, 'DisputeStarted', values),
    watcherLog(input.depositoryAddress, 'HankoBatchProcessed', [word('11'), word('77'), 3n], 1),
  ] });
  const { buildJEventObservationInput } = await import('../../../jurisdiction/adapter/events/event-observation');
  const observed = buildJEventObservationInput(input.env, decoded.events, {
    ...coordinates, adapterLabel: 'nonce-regression', watcherChainId: 31337,
    watcherDepositoryAddress: input.depositoryAddress,
  });
  // Rust served_start_uses_log_body_and_authenticated_batch_nonce_without_rpc expects the same N=3.
  const event = observed?.evidenceEvents.find(event => event.name === 'DisputeStarted');
  expect(event?.args['batchNonce']).toBe('3');
  expect(observed?.evidenceEvents.some(event => event.name === 'HankoBatchProcessed')).toBe(false);
});

test('compiled Account/Depository dispute topics equal TS and Rust decoder topics', async () => {
  const rust = await Bun.file('rscore/crates/runtime/src/j_watcher/abi.rs').text();
  for (const name of ['Account', 'Depository']) {
    const artifact = await Bun.file(`frontend/static/contracts/${name}.json`).json();
    const compiled = new ethers.Interface(artifact.abi);
    for (const [event, constant] of [
      ['DisputeStarted', 'DISPUTE_STARTED_TOPIC'],
      ['CounterDisputeRegistered', 'COUNTER_DISPUTE_REGISTERED_TOPIC'],
      ['DisputeFinalized', 'DISPUTE_FINALIZED_TOPIC'],
    ]) {
      const signature = compiled.getEvent(event!)!.format('sighash');
      const topic = rust.match(new RegExp(`${constant}: &str =\\s*"(0x[0-9a-f]+)"`))![1];
      expect(ethers.id(signature)).toBe(topic);
      expect(iface.getEvent(event!)!.topicHash).toBe(topic);
    }
  }
});

test('observed dispute survives watcher checkpoint/restore and finalizes without getLogs', async () => {
  const input = watcherInput();
  const values = [...start]; values[1] = input.replica.entityId; values[6] = '0x1234';
  const started = await decodeAuthenticatedWatcherEvents({ ...input,
    logs: [watcherLog(input.depositoryAddress, 'DisputeStarted', values)],
  });
  const { applyWatcherJurisdictionCursor } = await import('../../../jurisdiction/adapter/watcher/observe/watcher-cursor');
  const { buildCanonicalJReplicaSnapshot } = await import('../../../storage/wal/snapshot');
  const { validateRuntimeTx } = await import('../../../runtime/decode/runtime-tx');
  const walTx = validateRuntimeTx(safeParse(safeStringify({ type: 'advanceJWatcherCursor', data: {
    depositoryAddress: input.depositoryAddress, chainId: 31337, blockNumber: 42,
    disputeReferences: started.disputeReferences,
  } })), 'TEST_CURSOR_WAL');
  if (walTx.type !== 'advanceJWatcherCursor') throw new Error('TEST_CURSOR_TYPE');
  applyWatcherJurisdictionCursor(input.env, walTx.data);
  const { validateJReplicas } = await import('../../../storage/wal/runtime-machine-schema/j');
  const snapshot = structuredClone(buildCanonicalJReplicaSnapshot(input.watcherReplica));
  const restored = validateJReplicas([[snapshot.name, snapshot]], 'TEST_CHECKPOINT')[0]![1];
  const final = [...finalized]; final[1] = input.replica.entityId; final[5] = '0x';
  const fields = { ...finalization, initialProofbodyHash: hash, starterArgumentsHash: ethers.keccak256('0x1234') };
  final[6] = fields;
  final[4] = ethers.keccak256(coder.encode(
    ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
    [hash, 11n, false, true, fields.starterArgumentsHash, ethers.keccak256(fields.otherArguments), ethers.keccak256(fields.sig)],
  ));
  let reads = 0;
  const decoded = await decodeAuthenticatedWatcherEvents({ ...input, watcherReplica: restored,
    logs: [{ ...watcherLog(input.depositoryAddress, 'DisputeFinalized', final), blockNumber: 43 }],
    readDisputeReferenceLogs: async () => { reads++; throw new Error('NO_HISTORY_READ_EXPECTED'); },
  });
  expect(reads).toBe(0);
  expect(decoded.events[0]?.args['finalProofbody']).toEqual(body);
  expect(decoded.events[0]?.disputeFinalizationEvidence?.leftArguments).toBe('0x1234');
});

test('actual bytecode-emitted dispute logs round-trip and resolve after checkpoint restore', async () => {
  const { logs } = await Bun.file('core/__tests__/fixtures/jurisdiction/dispute-emitted-logs.json').json();
  const { emptyDisputeReferences, rememberDisputeReference } = await import('../../../jurisdiction/adapter/events/dispute/reference-state');
  let state = emptyDisputeReferences();
  const names = new Set<string>();
  for (const log of logs) {
    const parsed = iface.parseLog(log)!;
    expect(iface.encodeEventLog(parsed.fragment, parsed.args)).toEqual({ topics: log.topics, data: log.data });
    const event = decodeJEventLog(log, iface, { ...log, logIndex: log.logIndex }, 'EMITTED_DISPUTE');
    rememberDisputeReference(state, event);
    state = safeParse(safeStringify(state)) as typeof state;
    const resolved = await resolveDisputeLogReferences(event, async () => { throw new Error('UNEXPECTED_GET_LOGS'); }, state);
    expect(resolved.args[event.name === 'DisputeStarted' ? 'initialProofbody' : event.name === 'DisputeFinalized' ? 'finalProofbody' : 'counterProofbody']).toBeDefined();
    names.add(event.name);
  }
  expect([...names].sort()).toEqual(['CounterDisputeRegistered', 'DisputeFinalized', 'DisputeStarted']);
});

test('cache miss queries bounded pages from recorded start, never genesis', async () => {
  const { emptyDisputeReferences, disputePair } = await import('../../../jurisdiction/adapter/events/dispute/reference-state');
  const event = { ...decode('DisputeFinalized', [...finalized.slice(0, 5), '0x', finalization]), blockNumber: 1000 };
  const state = emptyDisputeReferences(); state.startBlocks[disputePair(event.args)] = 700;
  const pages: Array<[number | undefined, number | undefined]> = [];
  const resolved = await resolveDisputeLogReferences(event, async (_, from, to) => {
    pages.push([from, to]);
    return from === 956 ? [reference('DisputeStarted', start, 960)] : [];
  }, state);
  expect(pages).toEqual([[700, 955], [956, 1000]]);
  expect(resolved.args['finalProofbody']).toEqual(body);
});

test('cursor state rejects future evidence and wrong hash bytes before checkpointing', async () => {
  const { emptyDisputeReferences, rememberDisputeReference, validateDisputeReferences } = await import('../../../jurisdiction/adapter/events/dispute/reference-state');
  const state = emptyDisputeReferences(); rememberDisputeReference(state, decode('DisputeStarted', start));
  expect(() => validateDisputeReferences(state, 41)).toThrow('HEIGHT_INVALID');
  validateDisputeReferences(state, 42);
  Object.values(state.bodies)[0]!.bytes = '0x00';
  expect(() => validateDisputeReferences(state, 42)).toThrow('BYTES_INVALID');
});

test('rescan rebuilds dispute references when Entity finality leads the watcher cursor', async () => {
  const input = watcherInput();
  input.replica.state.lastFinalizedJHeight = 42;
  const values = [...start]; values[1] = input.replica.entityId;
  const result = await decodeAuthenticatedWatcherEvents({ ...input,
    logs: [watcherLog(input.depositoryAddress, 'DisputeStarted', values)],
  });
  expect(Object.keys(result.disputeReferences.bodies)).toHaveLength(1);
});
