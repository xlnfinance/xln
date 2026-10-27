import { expect, spyOn, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  decodeDisputeProofBodyEvidenceCalldata,
  resolveDisputeFinalizationEvidence,
} from '../../../jurisdiction/adapter/rpc-public';
import { DisputeCalldata } from '../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-calldata';
import {
  createTxDisputeProofBodyReader,
  createTxFinalizationEvidenceReader,
} from '../../../jurisdiction/adapter/rpc-watcher-inputs';
import {
  argsFor,
  body,
  depository,
  encodedBodyBytes,
  finalizationCall,
  location,
  nested,
  signedTransaction,
  sizedStart,
  startCall,
  word,
  wrap,
  type Body,
} from '../../helpers/jurisdiction/dispute-calldata-fixtures';

/** Observe real ABI decoding; no decoder or authentication behavior is replaced. */
const measureRecovery = async (data: string, proofbody = body) => {
  const tx = await signedTransaction(data);
  const original = ethers.AbiCoder.prototype.decode;
  let decodedBytes = 0;
  const observation = spyOn(ethers.AbiCoder.prototype, 'decode').mockImplementation(function (
    this: ethers.AbiCoder,
    ...args
  ) {
    decodedBytes += ethers.dataLength(args[1]);
    return original.apply(this, args);
  });
  const canonicalCalls = DisputeCalldata.prototype.canonicalCalls;
  const scannedOffsets: number[] = [];
  const scan = spyOn(DisputeCalldata.prototype, 'canonicalCalls').mockImplementation(function* (
    this: DisputeCalldata,
    ...args
  ) {
    for (const call of canonicalCalls.apply(this, args)) {
      scannedOffsets.push(call.offset);
      yield call;
    }
  });
  const started = performance.now();
  try {
    const recovered = await createTxDisputeProofBodyReader(tx.provider)(
      tx.hash,
      'DisputeStarted',
      argsFor(proofbody),
      location,
    );
    expect(recovered).toEqual(proofbody);
    return { decodedBytes, scannedOffsets, elapsedMs: performance.now() - started };
  } finally {
    scan.mockRestore();
    observation.mockRestore();
    console.info(
      `recovery input=${ethers.dataLength(data)} decoded=${decodedBytes} elapsed=${(performance.now() - started).toFixed(1)}ms`,
    );
  }
};

test('(a) actual=33,892 bytes survives processBatch(actual, 120 nested decoys=27,076 bytes, 1)', async () => {
  const { actual, proofbody } = sizedStart(33_892);
  const decoys = nested(wrap('0x'), 120);
  expect(ethers.dataLength(decoys)).toBe(27_076);
  const result = await measureRecovery(wrap(actual, decoys), proofbody);
  expect(result.decodedBytes).toBeLessThanOrEqual(encodedBodyBytes(proofbody));
});

test('(b) ~3 KB actual survives a shorter 15-level decoy chain with >=164-byte steps', async () => {
  const { actual, proofbody } = sizedStart(3_108);
  const decoys = nested(wrap('0x', '0x'), 15, false);
  expect(ethers.dataLength(decoys)).toBeLessThan(ethers.dataLength(actual));
  expect((ethers.dataLength(decoys) - ethers.dataLength(wrap('0x', '0x'))) / 15).toBeGreaterThanOrEqual(164);
  const result = await measureRecovery(wrap(actual, decoys), proofbody);
  expect(result.decodedBytes).toBeLessThanOrEqual(encodedBodyBytes(proofbody));
});

test('(c) 2048 canonical decoys in 1 MiB cannot spend decode bytes before the real call', async () => {
  const bytes = new Uint8Array(1024 * 1024);
  const decoy = ethers.getBytes(wrap('0x'));
  for (let index = 0; index < 2048; index += 1) bytes.set(decoy, index * decoy.length);
  bytes.set(ethers.getBytes(startCall()), 2048 * decoy.length);
  const result = await measureRecovery(ethers.hexlify(bytes));
  expect(result.decodedBytes).toBeLessThanOrEqual(encodedBodyBytes(body));
  expect(result.elapsedMs).toBeLessThan(1_000);
});

test('(d) 1900 nested canonical wrappers recover without a recursion/decode budget', async () => {
  const data = nested(startCall(), 1900);
  const result = await measureRecovery(data);
  expect(result.decodedBytes).toBeLessThanOrEqual(encodedBodyBytes(body));
});

test('(e) a valid direct call wins before decoys in its signature bytes are scanned or decoded', async () => {
  const actual = startCall();
  const parsed = depository.decodeFunctionData('processBatch', actual);
  const decoys = nested(wrap('0x'), 120);
  const direct = depository.encodeFunctionData('processBatch', [parsed[0], decoys, 1n]);
  const result = await measureRecovery(direct);
  expect(result.decodedBytes).toBeLessThanOrEqual(encodedBodyBytes(body));
});

test('(e2) decoys before a valid direct-call encoding cannot starve it', async () => {
  const decoys = ethers.concat(Array.from({ length: 120 }, () => wrap('0x')));
  const result = await measureRecovery(ethers.concat([decoys, startCall()]));
  expect(result.decodedBytes).toBeLessThanOrEqual(encodedBodyBytes(body));
});

test('(f) retry after a decoder budget event succeeds or surfaces a typed operator error', async () => {
  const { actual, proofbody } = sizedStart(33_892);
  const data = wrap(actual, nested(wrap('0x'), 120));
  const tx = await signedTransaction(data);
  const reader = createTxDisputeProofBodyReader(tx.provider);
  const outcomes: Array<Body | Error> = [];
  const original = ethers.AbiCoder.prototype.decode;
  let decodedBytes = 0;
  // A resource tripwire around the real decoder, reset per poll. It exposes
  // swallowed exhaustion without assuming a production budget API exists.
  const observation = spyOn(ethers.AbiCoder.prototype, 'decode').mockImplementation(function (
    this: ethers.AbiCoder,
    ...args
  ) {
    decodedBytes += ethers.dataLength(args[1]);
    if (decodedBytes > ethers.dataLength(data)) {
      const error = new Error(`J_DISPUTE_CALLDATA_BUDGET_EXCEEDED:${tx.hash}:${decodedBytes}`);
      error.name = 'DisputeCalldataBudgetError';
      throw error;
    }
    return original.apply(this, args);
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      decodedBytes = 0;
      try {
        outcomes.push((await reader(tx.hash, 'DisputeStarted', argsFor(proofbody), location)) as Body);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        outcomes.push(error);
      }
    }
  } finally {
    observation.mockRestore();
  }
  const last = outcomes[1];
  if (last instanceof Error) {
    expect(last.name).not.toBe('Error');
    expect(last.message).toContain(tx.hash);
    expect(last.message).toMatch(/BUDGET|LIMIT|RESOURCE/);
    expect(tx.reads()).toBe(2);
  } else expect(last).toEqual(proofbody);
});

test('(g) three-level canonical wrappers recover finalized body and sidecar evidence', async () => {
  const tx = await signedTransaction(nested(finalizationCall(), 3));
  const args = { ...argsFor(body), initialNonce: 7n, finalProofbodyHash: argsFor(body).proofbodyHash };
  expect(await createTxDisputeProofBodyReader(tx.provider)(tx.hash, 'DisputeFinalized', args, location)).toEqual(body);
  expect(await createTxFinalizationEvidenceReader(tx.provider)(tx.hash, location)).toEqual([
    expect.objectContaining({ initialNonce: '7', finalNonce: '11', leftArguments: '0x12', rightArguments: '0x34' }),
  ]);
});

test('(g2) three-level canonical wrappers recover the finalization sidecar independently', async () => {
  const tx = await signedTransaction(nested(finalizationCall(), 3));
  expect(await createTxFinalizationEvidenceReader(tx.provider)(tx.hash, location)).toEqual([
    expect.objectContaining({ initialNonce: '7', finalNonce: '11', leftArguments: '0x12', rightArguments: '0x34' }),
  ]);
});

test('I6: copying the event hash onto a different raw body does not authenticate it', async () => {
  const forged = { ...body, watchSeed: ethers.ZeroHash };
  const tx = await signedTransaction(wrap(startCall(forged, argsFor(body).proofbodyHash)));
  await expect(
    createTxDisputeProofBodyReader(tx.provider)(tx.hash, 'DisputeStarted', argsFor(body), location),
  ).rejects.toThrow('J_DISPUTE_PROOFBODY_EVIDENCE_NOT_FOUND');
});

test('I3: inconsistent offset chains do not trigger full candidate decoding', async () => {
  const bytes = new Uint8Array(1024 * 1024);
  const selector = ethers.getBytes(depository.getFunction('processBatch')!.selector);
  for (let index = 0; index < 2048; index += 1) {
    const offset = index * 480;
    bytes.set(selector, offset);
    word(bytes, offset + 4, 96);
    word(bytes, offset + 36, 128);
    word(bytes, offset + 100, 1);
    word(bytes, offset + 132, 32);
  }
  bytes.set(ethers.getBytes(startCall()), 2048 * 480);
  const result = await measureRecovery(ethers.hexlify(bytes));
  expect(result.decodedBytes).toBeLessThanOrEqual(encodedBodyBytes(body));
});

test.each([0, 3])('C1: processBatch accepts a trailing batch word through %i wrappers', async depth => {
  const [batch, hanko, nonce] = depository.decodeFunctionData('processBatch', startCall());
  const direct = depository.encodeFunctionData('processBatch', [ethers.concat([batch, ethers.ZeroHash]), hanko, nonce]);
  expect(decodeDisputeProofBodyEvidenceCalldata(direct)[0]!.proofbody).toEqual(body);
  const result = await measureRecovery(depth === 0 ? direct : nested(direct, depth));
  expect(result.decodedBytes).toBeLessThanOrEqual(encodedBodyBytes(body));
});

const shortBytesBody = { ...body, transformers: [{ ...body.transformers[0]!, encodedBatch: '0xab' }] };
const dirtyPadding = (data: string): string => {
  const marker = `ab${'00'.repeat(31)}`;
  const index = data.indexOf(marker);
  if (index < 0 || data.indexOf(marker, index + 1) !== -1) throw new Error('FIXTURE_PADDING_NOT_UNIQUE');
  return `${data.slice(0, index + 2)}01${data.slice(index + 4)}`;
};

test('C2: direct processBatch ignores non-zero encodedBatch padding', async () => {
  const data = dirtyPadding(startCall(shortBytesBody));
  expect(decodeDisputeProofBodyEvidenceCalldata(data)[0]!.proofbody).toEqual(shortBytesBody);
  await measureRecovery(data, shortBytesBody);
});

test('C2: direct processBatch follows out-of-order proof-body tails', async () => {
  const bytes = ethers.getBytes(startCall());
  const bodyStart = (ethers.hexlify(bytes).lastIndexOf(body.watchSeed.slice(2)) - 2) / 2;
  const readWord = (slot: number) => Number(ethers.toBigInt(bytes.subarray(slot, slot + 32)));
  const offdeltas = bodyStart + readWord(bodyStart + 3 * 32);
  const tokenIds = bodyStart + readWord(bodyStart + 4 * 32);
  // Swap the 96-byte Int512[] and 64-byte uint256[] tails, preserving their values.
  const deltas = bytes.slice(offdeltas, tokenIds);
  const tokens = bytes.slice(tokenIds, tokenIds + 64);
  bytes.set(tokens, offdeltas);
  bytes.set(deltas, offdeltas + tokens.length);
  word(bytes, bodyStart + 3 * 32, offdeltas + tokens.length - bodyStart);
  word(bytes, bodyStart + 4 * 32, offdeltas - bodyStart);
  const data = ethers.hexlify(bytes);
  expect(decodeDisputeProofBodyEvidenceCalldata(data)[0]!.proofbody).toEqual(body);
  await measureRecovery(data);
});

const dirtyWatchtowerCall = (): string => {
  const args = [...depository.decodeFunctionData('watchtowerCounterDispute', finalizationCall())];
  args[1] = { ...args[1].toObject(), finalProofbody: shortBytesBody };
  return dirtyPadding(depository.encodeFunctionData('watchtowerCounterDispute', args));
};

test('C2: direct watchtower recovers a body with dirty padding', async () => {
  const tx = await signedTransaction(dirtyWatchtowerCall());
  const event = {
    ...argsFor(shortBytesBody),
    initialNonce: 7n,
    finalProofbodyHash: argsFor(shortBytesBody).proofbodyHash,
  };
  expect(await createTxDisputeProofBodyReader(tx.provider)(tx.hash, 'DisputeFinalized', event, location)).toEqual(
    shortBytesBody,
  );
});

test('C2: direct watchtower recovers a finalization sidecar with dirty padding', async () => {
  const tx = await signedTransaction(dirtyWatchtowerCall());
  expect(await createTxFinalizationEvidenceReader(tx.provider)(tx.hash, location)).toEqual([
    expect.objectContaining({
      initialNonce: '7',
      finalNonce: '11',
      leftArguments: '0x12',
      rightArguments: '0x34',
      sig: '0x',
    }),
  ]);
});

test('C2/I6: the direct decoder rejects a copied hash on a different body', async () => {
  const forged = { ...shortBytesBody, watchSeed: ethers.ZeroHash };
  const tx = await signedTransaction(dirtyPadding(startCall(forged, argsFor(shortBytesBody).proofbodyHash)));
  await expect(
    createTxDisputeProofBodyReader(tx.provider)(tx.hash, 'DisputeStarted', argsFor(shortBytesBody), location),
  ).rejects.toThrow('J_DISPUTE_PROOFBODY_EVIDENCE_NOT_FOUND');
});

test('C3: direct processBatch recovers with dirty padding and 327,845 total calldata bytes', async () => {
  const bytes = new Uint8Array(327_845);
  bytes.set(ethers.getBytes(dirtyPadding(startCall(shortBytesBody))));
  const result = await measureRecovery(ethers.hexlify(bytes), shortBytesBody);
  expect(result.decodedBytes).toBeLessThan(10_000);
});

test('C3/I1: dirty hanko padding decodes offset zero before 120 nested decoys', async () => {
  const [batch] = depository.decodeFunctionData('processBatch', startCall());
  const bytes = ethers.getBytes(wrap(batch, nested(wrap('0x'), 120)));
  const hanko = 4 + Number(ethers.toBigInt(bytes.subarray(36, 68)));
  const length = Number(ethers.toBigInt(bytes.subarray(hanko, hanko + 32)));
  bytes[hanko + 32 + length] = 1;
  const result = await measureRecovery(ethers.hexlify(bytes));
  expect(result.scannedOffsets.filter(offset => offset !== 0)).toEqual([]);
});

test('C4: a canonical decoy cannot suppress dirty direct watchtower finalization evidence', async () => {
  const decoy = [...depository.decodeFunctionData('watchtowerCounterDispute', finalizationCall())];
  decoy[1] = { ...decoy[1].toObject(), initialNonce: 8n, finalNonce: 12n };
  const tx = await signedTransaction(
    ethers.concat([dirtyWatchtowerCall(), depository.encodeFunctionData('watchtowerCounterDispute', decoy)]),
  );
  const event = {
    ...argsFor(shortBytesBody),
    sender: ethers.ZeroHash,
    initialNonce: 7n,
    finalProofbodyHash: argsFor(shortBytesBody).proofbodyHash,
    finalizationEvidenceHash: ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
        [ethers.ZeroHash, 11n, false, true, ethers.keccak256('0x12'), ethers.keccak256('0x34'), ethers.keccak256('0x')],
      ),
    ),
  };
  expect(await createTxDisputeProofBodyReader(tx.provider)(tx.hash, 'DisputeFinalized', event, location)).toEqual(
    shortBytesBody,
  );
  const candidates = await createTxFinalizationEvidenceReader(tx.provider)(tx.hash, location);
  expect(resolveDisputeFinalizationEvidence(candidates, tx.hash, event)).toMatchObject({
    initialNonce: '7',
    finalNonce: '11',
    sig: '0x',
  });
  expect(() =>
    resolveDisputeFinalizationEvidence(candidates, tx.hash, { ...event, finalizationEvidenceHash: ethers.ZeroHash }),
  ).toThrow('J_DISPUTE_FINALIZATION_EVIDENCE_NOT_FOUND');
});

test('C4/I1: dirty direct DisputeStarted wins before a canonical decoy with another nonce', async () => {
  const bytes = ethers.getBytes(startCall());
  // The start tuple begins with counterentity, then nonce.
  const tuple = (ethers.hexlify(bytes).indexOf(argsFor(body).counterentity.slice(2)) - 2) / 2;
  word(bytes, tuple + 32, 8);
  const result = await measureRecovery(ethers.concat([dirtyPadding(startCall(shortBytesBody)), bytes]), shortBytesBody);
  expect(result.scannedOffsets.filter(offset => offset !== 0)).toEqual([]);
});
