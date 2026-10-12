import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, ZeroHash, type JsonRpcProvider } from 'ethers';
import type { RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import { deriveMeshChildSeed } from '../../core/orchestrator/mesh/mesh-seeds';
import { deriveManagedEntityIdentity } from '../../core/orchestrator/daemon-control';
import { buildSingleSignerHanko } from '../../core/hanko/batch';
import { createEmptyBatch, computeBatchHankoHash, encodeJBatch } from '../../core/jurisdiction/machine/batch';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';

/** Capture actual bilateral signatures before a later payment makes them stale. */
export async function signedDisputePage(page: Page, hubId: string) {
  return page.evaluate(async hubId => {
    const debug = (
      window as Window & {
        __xln: {
          env(): RuntimeReplica;
          xln(): Promise<XLNModule>;
          store: { getState(): { activeEntityId: string | null } };
        };
      }
    ).__xln;
    const xln = await debug.xln();
    const env = debug.env();
    const entityId = debug.store.getState().activeEntityId;
    const entity = [...env.state.eReplicas.values()].find(e => e.entityId === entityId);
    const account = entity?.state.accounts.get(hubId);
    if (!entity || !account || account.pendingFrame || account.mempool.length)
      throw new Error('P6_SIGNED_ACCOUNT_NOT_QUIESCENT');
    const proof = xln.buildAccountProofBodyFromJurisdictions(env.state, account);
    const nonce = account.currentDisputeProofNonce;
    const proposerIsLeft = account.currentDisputeProofProposerIsLeft;
    const sig = account.currentDisputeProofHanko;
    const peerNonce = account.counterpartyDisputeProofNonce;
    if (
      !nonce ||
      !peerNonce ||
      proposerIsLeft === undefined ||
      !sig ||
      proof.proofBodyHash !== account.currentDisputeProofBodyHash
    )
      throw new Error('P6_COMMITTED_PROOF_SIGNATURE_MISSING');
    return {
      entityId: entity.entityId,
      nonce,
      peerNonce,
      proposerIsLeft,
      sig,
      body: proof.proofBodyStruct,
      hash: proof.proofBodyHash,
    };
  }, hubId);
}

/** The adversary signs its own outer batch, reusing only the victim's old genuine proof. */
export async function startStaleDispute(
  provider: JsonRpcProvider,
  depository: string,
  hubId: string,
  stale: Awaited<ReturnType<typeof signedDisputePage>>,
) {
  const root = process.env['XLN_RDB_ROOT'];
  if (!root || (await provider.getNetwork()).chainId !== 31337n) throw new Error('P6_PRIVATE_STAND_REQUIRED');
  const seed = readFileSync(join(root, 'secrets/mesh-root.seed'), 'utf8').trim();
  const hub = deriveManagedEntityIdentity({
    name: 'H1',
    seed: deriveMeshChildSeed(seed, 'runtime:H1'),
    signerLabel: 'h1-hub',
  });
  expect(hub.entityId.toLowerCase()).toBe(hubId);
  const contract = Depository__factory.connect(depository, new Wallet(hub.privateKeyHex, provider));
  const batch = createEmptyBatch();
  batch.disputeStarts.push({
    counterentity: stale.entityId,
    nonce: stale.nonce,
    proposerIsLeft: stale.proposerIsLeft,
    proofbodyHash: stale.hash,
    initialProofbody: stale.body,
    watchSeed: String(stale.body.watchSeed),
    sig: stale.sig,
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: ZeroHash,
  });
  const encoded = encodeJBatch(batch);
  const nonce = (await contract.entityNonces(hubId)) + 1n;
  const hash = computeBatchHankoHash(31337n, depository, encoded, nonce);
  const receipt = await (
    await contract.processBatch(encoded, buildSingleSignerHanko(hubId, hash, hub.privateKeyHex), nonce)
  ).wait();
  if (!receipt || receipt.status !== 1) throw new Error('P6_STALE_START_FAILED');
  return receipt;
}
