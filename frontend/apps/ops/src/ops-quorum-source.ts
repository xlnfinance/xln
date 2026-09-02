import registry from '../../../../audits/registry.json';
import { currentQuorumInteractions } from '../../../packages/runtime-client/src/qa-quorum-history';
import { decodeQuorumRegistry, interactionsFromRegistry } from '../../../packages/runtime-client/src/qa-quorum-registry';
import type { QuorumInteraction } from '../../../packages/runtime-client/src/qa-quorum-types';

export const OPS_QUORUM_INTERACTIONS: readonly QuorumInteraction[] = [
  ...interactionsFromRegistry(decodeQuorumRegistry(registry)),
  ...currentQuorumInteractions,
];
