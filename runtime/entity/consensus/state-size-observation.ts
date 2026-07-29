import { shortId } from '../../infra/logger';
import type { EntityRuntimeContext } from '../runtime-context';
import type { EntityState } from '../types';
import { entityLog } from './entity-log';
import { classifyEntityConsensusStateQuotaTransition, measureEntityConsensusStateBytes } from './state-quota';

type ConsumptionSizeLog = Readonly<{
  warning: boolean;
  details: Record<string, string>;
}>;

const ENTITY_SIZE_OBSERVATION_PERIOD_FRAMES = 100;

const measureConsumptionState = (state: EntityState) =>
  measureEntityConsensusStateBytes(state, {
    getAccumulatorState: candidate => candidate.consumptionAccumulator,
  });

export const prepareCommittedEntitySizeLog = (
  env: EntityRuntimeContext,
  preState: EntityState,
  postState: EntityState,
): ConsumptionSizeLog | null => {
  const configuredWarningBytes = env.runtimeConfig?.entityConsensusStateWarningBytes;
  // Canonical Entity encoding is already paid once for the consensus root.
  // Re-encoding both states on every frame solely for diagnostics would double
  // hot-path work. Explicit quotas retain per-frame precision; otherwise sample.
  if (
    configuredWarningBytes === undefined &&
    postState.height !== 1 &&
    postState.height % ENTITY_SIZE_OBSERVATION_PERIOD_FRAMES !== 0
  ) {
    return null;
  }
  const before = measureConsumptionState(preState);
  const after = measureConsumptionState(postState);
  const assessment = classifyEntityConsensusStateQuotaTransition(
    before.totalBytes,
    after.totalBytes,
    configuredWarningBytes === undefined ? undefined : { warningBytes: configuredWarningBytes },
  );
  return {
    warning: assessment.classification !== 'within',
    details: {
      entity: shortId(postState.entityId),
      outputCount: postState.consumptionAccumulator?.count.toString() ?? '0',
      consumptionTreeBytes: after.consumptionTreeBytes.toString(),
      totalBytes: after.totalBytes.toString(),
      warningBytes: assessment.warningBytes.toString(),
      overageBytes: assessment.overageBytes.toString(),
      classification: assessment.classification,
    },
  };
};

export const emitCommittedEntitySizeLog = (entry: ConsumptionSizeLog | null): void => {
  if (!entry) return;
  if (entry.warning) entityLog.warn('state.size_warning', entry.details);
  else entityLog.debug('state.size', entry.details);
};
