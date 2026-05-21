import { requireUsableContractAddress } from '../../contract-address';
import { isLeftEntity } from '../../entity-id-utils';
import { createStructuredLogger, shortId } from '../../logger';
import { initJBatch, batchAddSettlement } from '../../j-batch';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { EntityInput, EntityState, EntityTx } from '../../types';
import { formatEntityId } from '../../utils';

type SettleDiffsEntityTx = Extract<EntityTx, { type: 'settleDiffs' }>;

type SettleDiffsResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

const log = createStructuredLogger('entity.tx.settle');

export const handleSettleDiffsEntityTx = (
  entityState: EntityState,
  entityTx: SettleDiffsEntityTx,
): SettleDiffsResult => {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const { counterpartyEntityId, diffs, description, sig } = entityTx.data;

  for (const diff of diffs) {
    const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
    if (sum !== 0n) {
      throw new Error(`Settlement invariant violation: ${sum} !== 0`);
    }
  }

  if (!newState.accounts.has(counterpartyEntityId)) {
    throw new Error(`No account with ${counterpartyEntityId}`);
  }

  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);
  const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
  const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) {
    throw new Error('No jurisdiction configured for this entity');
  }

  const contractDiffs = diffs.map(d => ({
    tokenId: d.tokenId,
    leftDiff: d.leftDiff,
    rightDiff: d.rightDiff,
    collateralDiff: d.collateralDiff,
    ondeltaDiff: d.ondeltaDiff || 0n,
  }));

  if (!sig || sig === '0x') {
    throw new Error(
      `Settlement ${entityState.entityId.slice(-4)}↔${counterpartyEntityId.slice(-4)} missing hanko signature`,
    );
  }

  newState.jBatchState ||= initJBatch();
  const entityProviderAddress = requireUsableContractAddress(
    'entity_provider',
    jurisdiction.entityProviderAddress,
  );
  batchAddSettlement(
    newState.jBatchState,
    leftEntity,
    rightEntity,
    contractDiffs,
    [],
    sig,
    entityProviderAddress,
    '0x',
    0,
    entityState.entityId,
  );

  const firstValidator = entityState.config.validators[0];
  if (firstValidator) {
    outputs.push({
      entityId: entityState.entityId,
      signerId: firstValidator,
      entityTxs: [{
        type: 'j_broadcast',
        data: {},
      }],
    });
  }

  addMessage(newState, `🏦 ${description || 'Settlement'} queued to jBatch`);
  log.info('diffs_queued', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyEntityId),
    left: shortId(leftEntity),
    right: shortId(rightEntity),
    diffCount: contractDiffs.length,
    account: formatEntityId(counterpartyEntityId),
  });

  return { newState, outputs };
};
