import type { CrossHub } from './cross-hub';
/** Genuine historical Account proof against native H1 after a committed cross-J Pull. */
import { ethers } from 'ethers';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { validateAccountReplica } from '../../../../account/validation/state-validation';
import { buildAccountProofBody } from '../../../../protocol/dispute/proof-builder';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { createEmptyBatch, encodeJBatch } from '../../../../jurisdiction/machine/batch';
import { hashDepositoryBatchHankoPayload, hashDisputeProofHankoPayload } from '../../../../hanko/onchain-domain';
import { safeStringify } from '../../../../protocol/serialization';
import { decodeUint768 } from '../../../../protocol/crypto/abi-money';
import { readWithRateLimitRetry, type ConnectedRuntime } from '../worker-runtime';
import type { ManagedEntityIdentity } from '../../../../orchestrator/daemon-control';

export const captureCounterproofAccount = async (
  runtime: ConnectedRuntime, entityId: string, hubEntityId: string, transformer: string, watchSeed: string,
) => {
  const page = requireBoundaryRecord(await readWithRateLimitRetry<unknown>(runtime,
    `entity/${entityId}/accounts`, { accountId: hubEntityId, accountsLimit: 1 }), 'COUNTERPROOF_PAGE');
  if (!Array.isArray(page['items']) || page['items'].length !== 1) throw new Error('COUNTERPROOF_ACCOUNT_CARDINALITY');
  const row = requireBoundaryRecord(page['items'][0], 'COUNTERPROOF_ACCOUNT_VIEW');
  const state = requireBoundaryRecord(row['state'], 'COUNTERPROOF_ACCOUNT_STATE');
  // Public projection redacts this secret. Re-derive from the owning local runtime seed;
  // the real peer Hanko/body hash below proves that this is the committed seed.
  const account = validateAccountReplica({ ...row, state: { ...state, watchSeed } }, 'COUNTERPROOF_ACCOUNT');
  const proof = buildAccountProofBody(account, transformer);
  if (!account.counterpartyDisputeProofHanko || account.counterpartyDisputeProofNonce === undefined ||
      proof.proofBodyHash !== account.counterpartyDisputeProofBodyHash) {
    throw new Error(`COUNTERPROOF_SIGNED_BODY_MISMATCH:height=${account.currentHeight}:peerNonce=${account.counterpartyDisputeProofNonce}:hasPeer=${Boolean(account.counterpartyDisputeProofHanko)}:rebuilt=${proof.proofBodyHash}:peer=${account.counterpartyDisputeProofBodyHash}:own=${account.currentDisputeProofBodyHash}`);
  }
  const key = ethers.solidityPacked(['bytes32', 'bytes32'], [account.state.leftEntity, account.state.rightEntity]);
  const roles = [false, true].filter(proposerIsLeft => hashDisputeProofHankoPayload(
    account.state.domain, key, account.counterpartyDisputeProofNonce!, proposerIsLeft, proof.proofBodyHash, watchSeed,
  ) === account.counterpartyDisputeHash);
  if (roles.length !== 1) throw new Error('COUNTERPROOF_SIGNED_ROLE_UNRESOLVED');
  return { account, proof, nonce: account.counterpartyDisputeProofNonce,
    proposerIsLeft: roles[0]!, hanko: account.counterpartyDisputeProofHanko };
};

export const runNativeCounterproof = async (options: {
  hub: CrossHub; runtime: ConnectedRuntime; identity: ManagedEntityIdentity; hubEntityId: string;
  rpcUrl: string; depositoryAddress: string; transformer: string; workDir: string;
  before: Awaited<ReturnType<typeof captureCounterproofAccount>>;
}) => {
  const after = await captureCounterproofAccount(options.runtime, options.identity.entityId,
    options.hubEntityId, options.transformer, options.before.account.state.watchSeed);
  if (after.nonce <= options.before.nonce || after.proof.proofBodyHash === options.before.proof.proofBodyHash) {
    throw new Error('COUNTERPROOF_NEWER_ECONOMIC_PROOF_REQUIRED');
  }
  writeFileSync(join(options.workDir, 'native-counterproof-proofs.json'), safeStringify({
    entityId: options.identity.entityId, hubEntityId: options.hubEntityId,
    before: { nonce: options.before.nonce, proposerIsLeft: options.before.proposerIsLeft,
      hash: options.before.proof.proofBodyHash, body: options.before.proof.proofBodyStruct },
    after: { nonce: after.nonce, ownNonce: after.account.currentDisputeProofNonce, proposerIsLeft: after.proposerIsLeft,
      hash: after.proof.proofBodyHash, body: after.proof.proofBodyStruct },
  }, 2), { mode: 0o600 });
  // The challenger hub uses the user's signed proof, while this local user's
  // counterpartyDisputeProof is the hub signature and may carry the other role nonce.
  const selectedNonce = after.account.currentDisputeProofNonce;
  if (selectedNonce === undefined || selectedNonce <= options.before.nonce ||
      !after.account.currentDisputeProofHanko || after.account.currentDisputeProofBodyHash !== after.proof.proofBodyHash) {
    throw new Error('COUNTERPROOF_OWN_SIGNED_CURRENT_BODY_REQUIRED');
  }
  const provider = new ethers.JsonRpcProvider(options.rpcUrl);
  // The local chain must produce empty blocks while no transaction is sent,
  // as a live chain does: estimateGas evaluates the latest mined timestamp.
  await provider.send('evm_setIntervalMining', [1]);
  const depository = Depository__factory.connect(options.depositoryAddress, await provider.getSigner(0));
  const chainId = (await provider.getNetwork()).chainId;
  const economicBefore = await Promise.all(after.proof.proofBodyStruct.tokenIds.map(async tokenId => ({
    tokenId, reserve: await depository._reserves(options.identity.entityId, tokenId),
    debt: decodeUint768(await depository.debtOutstanding(options.identity.entityId, tokenId)),
  })));
  const batch = createEmptyBatch();
  batch.disputeStarts.push({ counterentity: options.hubEntityId, nonce: options.before.nonce,
    proposerIsLeft: options.before.proposerIsLeft, proofbodyHash: options.before.proof.proofBodyHash,
    initialProofbody: options.before.proof.proofBodyStruct, watchSeed: options.before.account.state.watchSeed,
    sig: options.before.hanko, starterInitialArguments: '0x', starterCounterArguments: '0x',
    starterCounterProofCommitment: ethers.ZeroHash });
  const encoded = encodeJBatch(batch);
  const nonce = await depository.entityNonces(options.identity.entityId) + 1n;
  const digest = hashDepositoryBatchHankoPayload({ chainId, depositoryAddress: options.depositoryAddress }, encoded, nonce);
  const hanko = new ethers.SigningKey(options.identity.privateKeyHex).sign(digest).serialized;
  const receipt = await (await depository.processBatch(encoded, hanko, nonce, { gasLimit: 15_000_000n })).wait();
  if (!receipt || receipt.status !== 1) throw new Error('COUNTERPROOF_START_RECEIPT_FAILED');
  console.log(`[counterproof] old=${options.before.nonce} new=${selectedNonce} startBlock=${receipt.blockNumber}`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const events = await depository.queryFilter(depository.filters.CounterDisputeRegistered(
      options.hubEntityId, options.identity.entityId), receipt.blockNumber, 'latest');
    const event = events.find(row => row.args.nonce === BigInt(selectedNonce) && row.args.proofbodyHash === after.proof.proofBodyHash);
    if (event) {
      console.log(`[counterproof] counter nonce=${selectedNonce} block=${event.blockNumber} tx=${event.transactionHash}`);
      const [left, right] = [options.identity.entityId, options.hubEntityId].sort();
      const key = ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]);
      const active = await depository._accounts(key);
      const timeout = Number(active.disputeTimeout);
      if (timeout > Math.floor(Date.now() / 1_000) + 25) throw new Error('COUNTERPROOF_BOUNDED_CLOCK_REQUIRED');
      while (Math.floor(Date.now() / 1_000) <= timeout) await new Promise(resolve => setTimeout(resolve, 100));
      // The native scheduled deadline already owns finalization and broadcast.
      // Observe that production batch instead of submitting a second command.
      // Native J retries transient chain-time deferrals every 60 seconds.
      // Allow one real retry plus a 15-second receipt window (whole stand <180s).
      const finalDeadline = Date.now() + 75_000;
      let finalTxHash: string | null = null;
      while (Date.now() < finalDeadline) {
        const finals = await depository.queryFilter(depository.filters.DisputeFinalized(options.hubEntityId, options.identity.entityId), event.blockNumber, 'latest');
        const final = finals.find(row => row.args.nonce === BigInt(options.before.nonce) && row.args.finalProofbodyHash === after.proof.proofBodyHash);
        if (final) { finalTxHash = final.transactionHash; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!finalTxHash) throw new Error('COUNTERPROOF_NATIVE_FINALITY_TIMEOUT');
      const finalized = await depository._accounts(key);
      // Depository adopts the selected signed branch nonce exactly; only
      // the unchanged initial branch increments its previous nonce.
      if (finalized.nonce !== BigInt(selectedNonce) || finalized.disputeHash !== ethers.ZeroHash ||
          finalized.disputeTimeout !== 0n || finalized.disputeCounterNonce !== 0n ||
          finalized.disputeCounterProofbodyHash !== ethers.ZeroHash) {
        throw new Error('COUNTERPROOF_FINAL_ACCOUNT_NOT_CLOSED');
      }
      // An unfilled Pull authorizes no transfer. Selecting its newer proof must
      // close the dispute without charging the user or creating debt.
      for (const before of economicBefore) {
        const reserve = await depository._reserves(options.identity.entityId, before.tokenId);
        const debt = decodeUint768(await depository.debtOutstanding(options.identity.entityId, before.tokenId));
        if (reserve !== before.reserve || debt !== before.debt) {
          throw new Error(`COUNTERPROOF_UNFILLED_PULL_CHANGED_MONEY:${before.tokenId}:${before.reserve}:${reserve}:${before.debt}:${debt}`);
        }
      }
      const result = { schema: 'xln-native-newer-counterproof-v1', economicBefore, oldNonce: options.before.nonce,
        newNonce: selectedNonce, oldProofHash: options.before.proof.proofBodyHash,
        newProofHash: after.proof.proofBodyHash, startTxHash: receipt.hash, counterTxHash: event.transactionHash,
        counterBlock: event.blockNumber, finalTxHash, finalAccountNonce: finalized.nonce };
      writeFileSync(join(options.workDir, 'native-counterproof-report.json'), `${safeStringify(result, 2)}\n`);
      console.log(safeStringify(result));
      await provider.destroy();
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await provider.destroy();
  throw new Error(`COUNTERPROOF_NATIVE_RECEIPT_TIMEOUT:old=${options.before.nonce}:new=${selectedNonce}`);
};
