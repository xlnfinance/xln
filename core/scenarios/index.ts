import type { RuntimeReplica } from '../runtime/types';

export {
  SCENARIOS,
  getScenario,
  getScenariosByTag,
  type ScenarioMetadata,
} from './runner/catalog';

export type ScenarioEntry = {
  key: string;
  name: string;
  load: () => Promise<(env: RuntimeReplica) => Promise<void | RuntimeReplica>>;
  requiresStress?: boolean;
};

export const scenarioRegistry: ScenarioEntry[] = [
  { key: 'settle', name: 'Settlement', load: async () => {
    const { runSettleScenario } = await import('./settlement/settle');
    return async (env: RuntimeReplica): Promise<void> => { await runSettleScenario(env); };
  }},
  { key: 'ahb', name: 'AHB', load: async () => {
    const { ahb } = await import('./consensus/ahb');
    return async (env: RuntimeReplica): Promise<void> => { await ahb(env); };
  }},
  { key: 'lock-ahb', name: 'HTLC AHB', load: async () => {
    const { lockAhb } = await import('./payments/lock-ahb');
    return async (env: RuntimeReplica): Promise<void> => { await lockAhb(env); };
  }},
  { key: 'htlc-4hop', name: 'HTLC 4-Hop', load: async () => (await import('./payments/htlc-4hop')).htlc4hop },
  { key: 'cross-j', name: 'Cross-Jurisdiction Swap', load: async () => {
    const { crossJ } = await import('./cross-j');
    return async (env: RuntimeReplica): Promise<void> => { await crossJ(env); };
  }},
  { key: 'swap', name: 'Swap Trading', load: async () => (await import('./market/swap')).swap },
  { key: 'swap-market', name: 'Swap Market', load: async () => (await import('./market/swap-market')).swapMarket },
  { key: 'swap-tps', name: 'Swap TPS', load: async () => (await import('./market/swap-tps')).swapTps },
  { key: 'grid', name: 'Grid', load: async () => (await import('./consensus/grid')).grid },
  { key: 'multi-sig', name: 'Multi-Sig', load: async () => (await import('./consensus/multi-sig')).multiSig },
  { key: 'company-ipo', name: 'Company IPO', load: async () => (await import('./company-ipo')).companyIpo },
  {
    key: 'rapid-fire',
    name: 'Rapid Fire',
    requiresStress: true,
    load: async () => (await import('./consensus/rapid-fire')).rapidFire,
  },
  {
    key: 'processbatch',
    name: 'ProcessBatch Smoke',
    load: async () => {
      const { runProcessBatchScenario } = await import('./settlement/processbatch');
      return async (env: RuntimeReplica): Promise<RuntimeReplica> => runProcessBatchScenario(env);
    },
  },
  {
    key: 'dispute-lifecycle',
    name: 'Dispute Lifecycle',
    load: async () => {
      const { runDisputeLifecycle } = await import('./disputes/lifecycle');
      return async (env: RuntimeReplica): Promise<RuntimeReplica> => runDisputeLifecycle(env);
    },
  },
  {
    key: 'dispute-transformer',
    name: 'Programmable Dispute Transformer',
    load: async () => {
      const { runDisputeTransformer } = await import('./disputes/transformer');
      return async (env: RuntimeReplica): Promise<RuntimeReplica> => runDisputeTransformer(env);
    },
  },
];
