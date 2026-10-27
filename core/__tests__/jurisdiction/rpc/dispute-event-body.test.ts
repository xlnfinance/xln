import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { decodeJEventLog, parseReceiptLogsToJEvents } from '../../../jurisdiction/adapter/j-event-log-decoder';
import { resolveDisputeLogReferences } from '../../../jurisdiction/adapter/events/dispute/log-reference';
import { PROOF_BODY_ABI } from '../../../protocol/dispute/proof-body';

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
