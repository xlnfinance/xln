import registry from '../../../../../audits/registry.json';
import { currentQuorumInteractions } from '#lib/qa/quorum/current-history.ts';
import { interactionsFromRegistry, type QuorumRegistry } from '#lib/qa/quorum/derive.ts';

export const prerender = true;

export const load = () => ({
  interactions: [
    ...interactionsFromRegistry(registry as QuorumRegistry),
    ...currentQuorumInteractions,
  ],
});
