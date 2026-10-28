import { hashTargetReveal } from '../../protocol/htlc/target-reveal';
import { getJurisdictionStackId, requireJurisdictionChainId } from '../../jurisdiction/machine/jurisdiction-stack';
import type { RuntimeReplica } from '../types';
import type { GovernanceJTx } from './governance-submit-state';

/** Only the owning Entity's authenticated finalized registry projection retires
 * the signed witness. Receipt results, pending witnesses and foreign slots do not.
 * Bind the chain, Depository, ordered pair, role, ladder and immutable ratio;
 * otherwise another route/chain's reveal could strand this Target after a reorg.
 */
export const finalizedTargetReveal = (
  env: RuntimeReplica,
  jurisdictionName: string,
  jTx: GovernanceJTx,
): boolean => {
  if (jTx.type !== 'hashLadderReveal') return false;
  const state = env.state.eReplicas.get(`${jTx.entityId}:${jTx.data.signerId}`)?.state;
  const config = state?.config.jurisdiction;
  if (!state || !config || config.name !== jurisdictionName) return false;
  const registration = jTx.data.registration;
  if (hashTargetReveal(requireJurisdictionChainId(config.chainId), config.depositoryAddress, jTx.entityId, registration) !== jTx.data.revealHash) return false;
  return [...(state.crossJurisdictionSwaps?.values() ?? [])].some(route =>
    route.target.jurisdiction === getJurisdictionStackId(config)
    && route.target.counterpartyEntityId.toLowerCase() === jTx.entityId.toLowerCase()
    && route.target.entityId.toLowerCase() === registration.counterpartyEntity.toLowerCase()
    && route.targetPull?.fullHash === registration.fullHash
    && route.targetPull.partialRoot === registration.partialRoot
    && route.targetRegistryFillRatio === registration.witness.fillRatio
    && route.targetRegistryRecord?.fillRatio === registration.witness.fillRatio);
};
