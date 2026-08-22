import registry from '../../../../../audits/registry.json';
import { currentQuorumInteractions } from '$lib/qa/quorum/current-history';
import { interactionsFromRegistry, type QuorumRegistry } from '$lib/qa/quorum/derive';

export const prerender = true;

export const load = () => ({
  interactions: [
    ...interactionsFromRegistry(registry as QuorumRegistry),
    ...currentQuorumInteractions,
  ],
});
