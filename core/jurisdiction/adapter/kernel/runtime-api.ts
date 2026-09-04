import { requireUsableContractAddress } from '../../machine/contract-address';
import { detectEntityType, extractNumberFromEntityId } from '../../../entity/factory';
import { encodeJBatch, computeBatchHankoHash, type JBatch } from '../../machine/batch';
import { normalizeEntityId } from '../../../entity/id';
import { signEntityHashes } from '../../../hanko/signing';
import { compactHankoForChain } from '../../../hanko/short';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JurisdictionConfig } from '../../../entity/types';
import { connectJurisdictionAdapter, connectJurisdictionContracts } from './jurisdiction';

export const debugFundReserves = async (
  jurisdiction: JurisdictionConfig,
  entityId: string,
  tokenId: number,
  amount: string,
) => {
  const jadapter = await connectJurisdictionAdapter(jurisdiction);
  const events = await jadapter.debugFundReserves(entityId, tokenId, BigInt(amount));
  return { events };
};

export const submitProcessBatch = async (
  env: RuntimeReplica,
  jurisdiction: JurisdictionConfig,
  entityId: string,
  batch: JBatch,
  signerId?: string,
) => {
  if (!signerId) {
    throw new Error(`submitProcessBatch requires signerId for ${entityId.slice(0, 10)}`);
  }

  const { jadapter, provider, depository } = await connectJurisdictionContracts(jurisdiction);
  requireUsableContractAddress('entity_provider', jurisdiction.entityProviderAddress);

  const encodedBatch = encodeJBatch(batch);
  const chainId = BigInt((await provider.getNetwork()).chainId);
  const currentNonce = await depository.entityNonces(normalizeEntityId(entityId));
  const nextNonce = BigInt(currentNonce ?? 0n) + 1n;
  const batchHash = computeBatchHankoHash(
    chainId,
    await depository.getAddress(),
    encodedBatch,
    nextNonce,
  );
  const hankos = await signEntityHashes(env, entityId, signerId, [batchHash]);
  if (!hankos[0]) {
    throw new Error('Failed to build batch hanko signature');
  }
  const hankoData = compactHankoForChain(hankos[0], batchHash);

  const receipt = await jadapter.processBatch(encodedBatch, hankoData, nextNonce);
  return {
    transaction: { hash: receipt.txHash },
    receipt: { hash: receipt.txHash, blockNumber: receipt.blockNumber, events: receipt.events },
  };
};

// No on-chain name registry (EntityProvider has no nameToNumber/numberToName);
// human names live relay-side. This returns chain facts only.
export const getEntityInfoFromChain = async (
  entityId: string,
  jurisdiction: JurisdictionConfig,
): Promise<{ exists: boolean; entityNumber?: number }> => {
  try {
    const { entityProvider } = await connectJurisdictionContracts(jurisdiction);
    const entityInfo = await entityProvider.entities(entityId);
    if (entityInfo.registrationBlock === 0n) return { exists: false };

    const entityType = detectEntityType(entityId);
    let entityNumber: number | undefined;
    if (entityType === 'numbered') {
      const extractedNumber = extractNumberFromEntityId(entityId);
      if (extractedNumber !== null) entityNumber = extractedNumber;
    }

    return {
      exists: true,
      ...(entityNumber !== undefined ? { entityNumber } : {}),
    };
  } catch (error) {
    throw new Error(
      `GET_ENTITY_INFO_FROM_CHAIN_FAILED:entity=${normalizeEntityId(entityId)}:` +
      `${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
};
