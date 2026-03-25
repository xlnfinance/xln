import { requireUsableContractAddress } from '../contract-address';
import { detectEntityType, extractNumberFromEntityId } from '../entity-factory';
import { encodeJBatch, computeBatchHankoHash, type JBatch } from '../j-batch';
import { normalizeEntityId } from '../entity-id-utils';
import { signHashesAsSingleEntity } from '../hanko/signing';
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
  const hankos = await signHashesAsSingleEntity(env, entityId, signerId, [batchHash]);
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

export const assignNameOnChain = async (
  name: string,
  entityNumber: number,
  jurisdiction: JurisdictionConfig,
): Promise<{ txHash: string }> => {
  const { entityProvider } = await connectJurisdictionContracts(jurisdiction);
  const tx = await entityProvider.assignName(name, entityNumber);
  const receipt = await tx.wait();
  if (!receipt || receipt.status === 0) {
    throw new Error(`assignName failed for ${name}`);
  }
  return { txHash: receipt.hash };
};

export const getEntityInfoFromChain = async (
  entityId: string,
  jurisdiction: JurisdictionConfig,
): Promise<{ exists: boolean; entityNumber?: number; name?: string }> => {
  try {
    const { entityProvider } = await connectJurisdictionContracts(jurisdiction);
    const entityInfo = await entityProvider.entities(entityId);
    if (Number(entityInfo.status) === 0) return { exists: false };

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
  } catch {
    return { exists: false };
  }
};

export const transferNameBetweenEntities = async (
  name: string,
  _fromNumber: number,
  toNumber: number,
  jurisdiction: JurisdictionConfig,
): Promise<string> => {
  const { entityProvider } = await connectJurisdictionContracts(jurisdiction);
  const tx = await entityProvider.transferName(name, toNumber);
  const receipt = await tx.wait();
  if (!receipt || receipt.status === 0) {
    throw new Error(`transferName failed for ${name}`);
  }
  return receipt.hash;
};
