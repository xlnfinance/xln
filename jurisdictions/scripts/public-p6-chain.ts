#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JsonRpcProvider, Wallet, ZeroHash, toQuantity, isHexString } from 'ethers';
import { deriveMeshChildSeed } from '../../core/orchestrator/mesh/mesh-seeds';
import { deriveManagedEntityIdentity } from '../../core/orchestrator/daemon-control';
import { assertCanonicalRpcContractStack } from '../../core/orchestrator/bootstrap/contract-readiness';
import { prepareSignedBatch } from '../../core/hanko/batch';
import { createEmptyBatch } from '../../core/jurisdiction/machine/batch';
import { validateProofBody } from '../../core/jurisdiction/machine/batch-validation';
import { computeAccountKey } from '../../core/jurisdiction/adapter/events/contract-codec';
import type { ProofBodyStruct } from '../../core/protocol/dispute/proof-body';
import {
  requireBoundaryRecord,
  requireBoundaryInteger,
  requireString,
  requireBoolean,
  requireBigInt,
} from '../../core/protocol/boundary/boundary-primitives';
import { safeParse, safeStringify } from '../../core/protocol/serialization';
import { Depository__factory } from '../../jurisdictions/typechain-types';

const mode = process.argv[2];
if (mode !== 'attack' && mode !== 'observe') throw Error('PUBLIC_P6_CHAIN_MODE_REQUIRED');
const directory = resolve(requireString(process.env['PUBLIC_P6_DATA'], 'PUBLIC_P6_DATA_REQUIRED'));
if (!directory.includes('/sepolia-p6-')) throw Error('PUBLIC_P6_DEDICATED_DIRECTORY_REQUIRED');
const prepared = requireBoundaryRecord(
  safeParse(readFileSync(`${directory}/prepared.json`, 'utf8')),
  'PUBLIC_P6_PREPARED',
);
const text = (value: unknown) => requireString(value, 'PUBLIC_P6_STRING_REQUIRED');
const hash = (value: unknown, length: number) => {
  const result = text(value);
  if (!isHexString(result, length)) throw Error('PUBLIC_P6_HEX_INVALID');
  return result;
};
const entityId = hash(prepared['entityId'], 32);
const hubId = hash(prepared['hub'], 32);
const owner = hash(prepared['signerId'], 20);
const tower = hash(prepared['tower'], 20);
const ownerNonce = requireBoundaryInteger(prepared['ownerNonce'], 'PUBLIC_P6_OWNER_NONCE');
const expectedReserve = requireBigInt(prepared['expectedReserve'], 'PUBLIC_P6_EXPECTED_RESERVE');
if (expectedReserve < 100_000_000n) throw Error('PUBLIC_P6_EXPECTED_RESERVE_TOO_SMALL');
const rpc = text(prepared['rpc']);
const contracts = requireBoundaryRecord(prepared['contracts'], 'PUBLIC_P6_CONTRACTS');
const addresses = {
  account: hash(contracts['account'], 20),
  entityProvider: hash(contracts['entityProvider'], 20),
  depository: hash(contracts['depository'], 20),
  deltaTransformer: hash(contracts['deltaTransformer'], 20),
};
const latest = requireBoundaryRecord(prepared['latest'], 'PUBLIC_P6_LATEST');
const latestHash = hash(latest['hash'], 32);
const peerNonce = requireBoundaryInteger(prepared['peerNonce'], 'PUBLIC_P6_PEER_NONCE');
const provider = new JsonRpcProvider(rpc, 11155111, { cacheTimeout: -1 });
provider.pollingInterval = 2_000;
const contract = Depository__factory.connect(addresses.depository, provider);
const accountKey = computeAccountKey(entityId, hubId);
const evidence = `${directory}/chain.json`;
const save = (report: unknown) => Bun.write(evidence, safeStringify(report, 2));

try {
  if ((await provider.getNetwork()).chainId !== 11155111n) throw Error('PUBLIC_P6_SEPOLIA_ONLY');
  await assertCanonicalRpcContractStack(rpc, addresses, 'PUBLIC_P6', 10_000);
  if ((await provider.getTransactionCount(owner, 'pending')) !== ownerNonce)
    throw Error('PUBLIC_P6_OWNER_SENT_TRANSACTION');
  if (mode === 'attack') {
    if (await Bun.file(evidence).exists()) throw Error('PUBLIC_P6_ATTACK_ALREADY_STARTED_INSPECT_EVIDENCE');
    const seedFile = text(process.env['PUBLIC_P6_MESH_SEED_FILE']);
    const hub = deriveManagedEntityIdentity({
      name: 'H1',
      seed: deriveMeshChildSeed(readFileSync(seedFile, 'utf8').trim(), 'runtime:H1'),
      signerLabel: 'h1-hub',
    });
    if (hub.entityId.toLowerCase() !== hubId) throw Error('PUBLIC_P6_HUB_IDENTITY_MISMATCH');
    const relayer = new Wallet(text(process.env['PUBLIC_P6_RELAYER_PRIVATE_KEY']), provider);
    if (relayer.address.toLowerCase() === owner) throw Error('PUBLIC_P6_OWNER_MUST_STAY_OFFLINE');
    const stale = requireBoundaryRecord(prepared['stale'], 'PUBLIC_P6_STALE');
    const body = validateProofBody(stale['body'], 'PUBLIC_P6_STALE_PROOF') as ProofBodyStruct;
    const batch = createEmptyBatch();
    // The adversary signs only its own outer batch; the victim's old genuine
    // proof was captured before the later payment and is never reconstructed.
    batch.disputeStarts.push({
      counterentity: entityId,
      nonce: requireBoundaryInteger(stale['nonce'], 'PUBLIC_P6_STALE_NONCE'),
      proposerIsLeft: requireBoolean(stale['proposerIsLeft'], 'PUBLIC_P6_PROPOSER'),
      proofbodyHash: hash(stale['hash'], 32),
      initialProofbody: body,
      watchSeed: text(body.watchSeed),
      sig: text(stale['sig']),
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
      starterCounterProofCommitment: ZeroHash,
    });
    const block = await provider.getBlock('latest');
    if (!block) throw Error('PUBLIC_P6_BLOCK_MISSING');
    const current = await contract._accounts(accountKey, { blockTag: block.number });
    const collateral = await contract._collaterals(accountKey, 1, { blockTag: block.number });
    const reserve = await contract._reserves(entityId, 1, { blockTag: block.number });
    if (
      current.disputeHash !== ZeroHash ||
      collateral.collateral !== 100_000_000n ||
      reserve !== expectedReserve - 100_000_000n
    )
      throw Error('PUBLIC_P6_INITIAL_CHAIN_STATE_CHANGED');
    const signed = prepareSignedBatch(
      batch,
      hubId,
      hub.privateKeyHex,
      11155111n,
      addresses.depository,
      await contract.entityNonces(hubId, { blockTag: block.number }),
    );
    const data = contract.interface.encodeFunctionData('processBatch', [
      signed.encodedBatch,
      signed.hankoData,
      signed.nextNonce,
    ]);
    const estimated = BigInt(
      await provider.send('eth_estimateGas', [
        { from: relayer.address, to: addresses.depository, data },
        toQuantity(block.number),
      ]),
    );
    const gasLimit = (estimated * 12n + 9n) / 10n;
    if (gasLimit > 5_000_000n) throw Error('PUBLIC_P6_START_GAS_BUDGET');
    const before = {
      entityId,
      hubId,
      owner,
      tower,
      ownerNonce,
      expectedReserve,
      accountKey,
      latestHash,
      peerNonce,
      chainId: 11155111,
      status: 'submitting',
      previousBlock: block.number,
    };
    await save(before);
    const tx = await relayer.sendTransaction({ to: addresses.depository, data, gasLimit });
    await save({ ...before, status: 'submitted', startHash: tx.hash });
    const receipt = await tx.wait(1, 60_000);
    if (!receipt || receipt.status !== 1) throw Error('PUBLIC_P6_START_FAILED');
    // The successful receipt is the start witness. Separate state/block RPC
    // reads can lag it and must not turn an executed start into a retry.
    const starts = receipt.logs
      .filter(log => log.address.toLowerCase() === addresses.depository.toLowerCase())
      .map(log => contract.interface.parseLog(log))
      .filter(event => event?.name === 'DisputeStarted');
    const started = starts[0];
    const submitted = batch.disputeStarts[0]!;
    if (
      starts.length !== 1 ||
      !started ||
      started.args.sender.toLowerCase() !== hubId ||
      started.args.counterentity.toLowerCase() !== entityId ||
      started.args.nonce !== BigInt(submitted.nonce) ||
      started.args.proofbodyHash !== submitted.proofbodyHash ||
      started.args.proposerIsLeft !== submitted.proposerIsLeft ||
      started.args.watchSeed !== submitted.watchSeed ||
      started.args.starterInitialArguments !== submitted.starterInitialArguments ||
      started.args.starterCounterArguments !== submitted.starterCounterArguments ||
      started.args.starterCounterProofCommitment !== submitted.starterCounterProofCommitment
    )
      throw Error('PUBLIC_P6_START_RECEIPT_MISMATCH');
    const timestamp = Number(started.args.disputeStartTimestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || started.args.disputeTimeout < BigInt(timestamp))
      throw Error('PUBLIC_P6_START_TIME_INVALID');
    const report = {
      ...before,
      status: 'waiting-for-tower',
      start: { hash: tx.hash, gasUsed: receipt.gasUsed, block: receipt.blockNumber, timestamp },
      timeout: started.args.disputeTimeout,
    };
    await save(report);
    console.log(safeStringify(report));
  } else {
    const report = requireBoundaryRecord(safeParse(readFileSync(evidence, 'utf8')), 'PUBLIC_P6_CHAIN_REPORT');
    const start = requireBoundaryRecord(report['start'], 'PUBLIC_P6_START');
    const fromBlock = requireBoundaryInteger(start['block'], 'PUBLIC_P6_START_BLOCK');
    const block = await provider.getBlock('latest');
    if (!block) throw Error('PUBLIC_P6_BLOCK_MISSING');
    const [account, collateral, reserve, counters, finals] = await Promise.all([
      contract._accounts(accountKey, { blockTag: block.number }),
      contract._collaterals(accountKey, 1, { blockTag: block.number }),
      contract._reserves(entityId, 1, { blockTag: block.number }),
      contract.queryFilter(contract.filters.CounterDisputeRegistered(entityId, hubId), fromBlock, block.number),
      contract.queryFilter(contract.filters.DisputeFinalized(), fromBlock, block.number),
    ]);
    const counter = counters.find(
      event => event.args.nonce === BigInt(peerNonce) && event.args.proofbodyHash === latestHash,
    );
    const final = finals.find(
      event =>
        computeAccountKey(event.args.sender, event.args.counterentity) === accountKey &&
        event.args.finalProofbodyHash === latestHash,
    );
    const receipts: { kind: string; hash: string; gasUsed: bigint; block: number; from: string }[] = [];
    for (const [kind, event] of [
      ['counter', counter],
      ['finalize', final],
    ] as const) {
      if (!event) continue;
      const receipt = await provider.getTransactionReceipt(event.transactionHash);
      if (!receipt || receipt.status !== 1 || receipt.from.toLowerCase() !== tower.toLowerCase())
        throw Error(`PUBLIC_P6_TOWER_RECEIPT_INVALID:${kind}`);
      receipts.push({
        kind,
        hash: receipt.hash,
        gasUsed: receipt.gasUsed,
        block: receipt.blockNumber,
        from: receipt.from,
      });
    }
    const verified = Boolean(
      counter &&
      final &&
      collateral.collateral === 0n &&
      reserve === expectedReserve &&
      account.disputeHash === ZeroHash &&
      account.nonce === BigInt(peerNonce),
    );
    const observation = {
      block: block.number,
      timestamp: block.timestamp,
      accountNonce: account.nonce,
      counterNonce: account.disputeCounterNonce,
      reserve,
      collateral: collateral.collateral,
      receipts,
    };
    await save({ ...report, status: verified ? 'tower-finalized' : 'waiting-for-tower', verified, observation });
    console.log(safeStringify({ verified, ...observation }));
  }
} finally {
  provider.destroy();
}
