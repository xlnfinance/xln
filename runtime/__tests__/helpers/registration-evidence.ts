import { ethers } from 'ethers';

import { EntityProvider__factory } from '../../../jurisdictions/typechain-types';
import type { CertifiedRegistrationEvidence, EntityState, Env, JurisdictionConfig, JurisdictionEvent } from '../../types';
import {
  computeCanonicalReceiptsRoot,
  createCanonicalReceiptProofs,
  type AuthenticatedRpcLog,
  type CanonicalRpcReceipt,
} from '../../jadapter/receipt-root';
import {
  buildCertifiedRegistrationEvidence,
  markLocalJAuthorityRuntimeTx,
} from '../../jurisdiction/registration-evidence';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
} from '../../jurisdiction/board-registry';
import { applyRuntimeTx } from '../../machine/tx-handlers';

const zeroBloom = `0x${'00'.repeat(256)}`;
const heightHash = (value: number): string => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`TEST_REGISTRATION_EVIDENCE_HEIGHT_INVALID:${String(value)}`);
  }
  return ethers.zeroPadValue(ethers.toBeHex(value), 32).toLowerCase();
};

export const installCanonicalRegistrationEvidence = async (
  env: Env,
  jurisdiction: JurisdictionConfig,
  entityId: string,
  boardHash: string,
  options: {
    source?: CertifiedRegistrationEvidence['source'];
    activationHeight?: number;
  } = {},
): Promise<CertifiedRegistrationEvidence> => {
  const source = options.source ?? 'EntityRegistered';
  const activationHeight = options.activationHeight ?? 5;
  const stackKey = getCertifiedBoardStackKey(jurisdiction);
  const replica = Array.from(env.jReplicas.values()).find(candidate => (
    candidate.chainId === jurisdiction.chainId &&
    candidate.depositoryAddress?.toLowerCase() === jurisdiction.depositoryAddress.toLowerCase() &&
    candidate.entityProviderAddress?.toLowerCase() === jurisdiction.entityProviderAddress.toLowerCase()
  ));
  if (!replica || replica.watcherConfirmationDepth === undefined) {
    throw new Error(`TEST_REGISTRATION_EVIDENCE_STACK_MISSING:${stackKey}`);
  }
  const iface = EntityProvider__factory.createInterface();
  const encoded = source === 'EntityRegistered'
    ? iface.encodeEventLog(iface.getEvent('EntityRegistered'), [entityId, BigInt(entityId), boardHash])
    : iface.encodeEventLog(iface.getEvent('FoundationBootstrapped'), [
        ethers.getAddress(env.runtimeId!),
        boardHash,
        2n,
        3n,
      ]);
  const blockHash = heightHash(activationHeight);
  const transactionHash = heightHash(activationHeight + 64);
  const receipt: CanonicalRpcReceipt = {
    transactionHash,
    transactionIndex: 0,
    blockNumber: activationHeight,
    blockHash,
    type: 0,
    status: 1,
    cumulativeGasUsed: 21_000,
    logsBloom: zeroBloom,
    logs: [{
      address: jurisdiction.entityProviderAddress,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: activationHeight,
      blockHash,
      transactionHash,
      transactionIndex: 0,
      logIndex: 0,
    }],
  };
  const receiptsRoot = await computeCanonicalReceiptsRoot([receipt]);
  const proof = (await createCanonicalReceiptProofs([receipt], receiptsRoot)).get(0);
  if (!proof) throw new Error('TEST_REGISTRATION_EVIDENCE_PROOF_MISSING');
  const log: AuthenticatedRpcLog = {
    address: jurisdiction.entityProviderAddress.toLowerCase(),
    topics: encoded.topics.map(topic => topic.toLowerCase()),
    data: encoded.data.toLowerCase(),
    blockNumber: activationHeight,
    blockHash,
    transactionHash,
    transactionIndex: 0,
    logIndex: 0,
    index: 0,
    receiptProof: { ...proof, receiptLogIndex: 0 },
  };
  const evidence = buildCertifiedRegistrationEvidence(env, replica, source, log, {
    observedThroughHeight: activationHeight,
    observedTipBlockHash: blockHash,
    observedHeadHeight: activationHeight + replica.watcherConfirmationDepth,
    confirmationDepth: replica.watcherConfirmationDepth,
  });
  await applyRuntimeTx(env, markLocalJAuthorityRuntimeTx({
    type: 'recordAuthenticatedJAuthority',
    data: evidence,
  }));
  return evidence;
};

export const installCanonicalRegisteredBoardAuthority = async (
  env: Env,
  jurisdiction: JurisdictionConfig,
  state: EntityState,
  boardHash: string,
  options: { activationHeight?: number } = {},
): Promise<CertifiedRegistrationEvidence> => {
  const evidence = await installCanonicalRegistrationEvidence(
    env,
    jurisdiction,
    state.entityId,
    boardHash,
    { activationHeight: options.activationHeight },
  );
  const foundationHeight = Number(
    jurisdiction.entityProviderDeploymentBlock ?? evidence.activationHeight - 1,
  );
  const events: JurisdictionEvent[] = [{
    type: 'FoundationBootstrapped',
    data: { recipient: env.runtimeId!, boardHash: ethers.ZeroHash, controlTokenId: '2', dividendTokenId: '3' },
    blockNumber: foundationHeight,
    blockHash: heightHash(foundationHeight),
    transactionHash: heightHash(foundationHeight + 32),
    logIndex: 0,
  }, {
    type: 'EntityRegistered',
    data: { entityId: state.entityId, entityNumber: BigInt(state.entityId).toString(), boardHash },
    blockNumber: evidence.activationHeight,
    blockHash: evidence.blockHash,
    transactionHash: evidence.transactionHash,
    logIndex: evidence.logIndex,
  }];
  for (const event of events) {
    const applied = applyCertifiedBoardRegistryEvent(
      state.certifiedBoardState,
      getCertifiedBoardNodeStore(env),
      jurisdiction,
      event,
    );
    cacheCertifiedBoardNodes(env, applied.newNodes);
    state.certifiedBoardState = applied.state;
  }
  return evidence;
};
