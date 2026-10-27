import { detectEntityType, extractNumberFromEntityId } from '../../../entity/factory';
import { normalizeEntityId } from '../../../entity/id';
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
