import { requireUsableContractAddress } from '../jurisdiction/contract-address';
import { detectEntityType, extractNumberFromEntityId } from '../entity/factory';
import { encodeJBatch, computeBatchHankoHash, type JBatch } from '../jurisdiction/batch';
import { normalizeEntityId } from '../entity/id';
import { signEntityHashes } from '../hanko/signing';
import type { Env, JurisdictionConfig } from '../types';
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
  env: Env,
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
  const hankoData = hankos[0];
  if (!hankoData) {
    throw new Error('Failed to build batch hanko signature');
  }

  const receipt = await jadapter.processBatch(encodedBatch, hankoData, nextNonce);
  return {
    transaction: { hash: receipt.txHash },
    receipt: { hash: receipt.txHash, blockNumber: receipt.blockNumber, events: receipt.events },
  };
};

export const getEntityInfoFromChain = async (
  entityId: string,
  jurisdiction: JurisdictionConfig,
): Promise<{ exists: boolean; entityNumber?: number; name?: string }> => {
  try {
    const { entityProvider } = await connectJurisdictionContracts(jurisdiction);
    const entityInfo = await entityProvider.entities(entityId);
    if (entityInfo.registrationBlock === 0n) return { exists: false };

    const entityType = detectEntityType(entityId);
    let entityNumber: number | undefined;
    let name: string | undefined;
    if (entityType === 'numbered') {
      const extractedNumber = extractNumberFromEntityId(entityId);
      if (extractedNumber !== null) {
        entityNumber = extractedNumber;
        const resolvedName = await entityProvider.numberToName(entityNumber);
        if (resolvedName) name = resolvedName;
      }
    }

    return {
      exists: true,
      ...(entityNumber !== undefined ? { entityNumber } : {}),
      ...(name !== undefined ? { name } : {}),
    };
  } catch (error) {
    throw new Error(
      `GET_ENTITY_INFO_FROM_CHAIN_FAILED:entity=${normalizeEntityId(entityId)}:` +
      `${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
};
