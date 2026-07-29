import type { RuntimeState } from './types';

export const scenarios = {
  ahb: async (env: RuntimeState): Promise<RuntimeState> => {
    const { ahb } = await import('../scenarios/ahb');
    await ahb(env);
    return env;
  },
  lockAhb: async (env: RuntimeState): Promise<RuntimeState> => {
    const { lockAhb } = await import('../scenarios/lock-ahb');
    await lockAhb(env);
    return env;
  },
  swap: async (env: RuntimeState): Promise<RuntimeState> => {
    const { swap, swapWithOrderbook, multiPartyTrading } = await import('../scenarios/swap');
    await swap(env);
    await swapWithOrderbook(env);
    await multiPartyTrading(env);
    return env;
  },
  swapMarket: async (env: RuntimeState): Promise<RuntimeState> => {
    const { swapMarket } = await import('../scenarios/swap-market');
    await swapMarket(env);
    return env;
  },
  rapidFire: async (env: RuntimeState): Promise<RuntimeState> => {
    const { rapidFire } = await import('../scenarios/rapid-fire');
    await rapidFire(env);
    return env;
  },
  grid: async (env: RuntimeState): Promise<RuntimeState> => {
    const { grid } = await import('../scenarios/grid');
    await grid(env);
    return env;
  },
  settle: async (env: RuntimeState): Promise<RuntimeState> => {
    const { runSettleScenario } = await import('../scenarios/settle');
    await runSettleScenario(env);
    return env;
  },
  disputeLifecycle: async (env: RuntimeState): Promise<RuntimeState> => {
    const { runDisputeLifecycle } = await import('../scenarios/dispute-lifecycle');
    return await runDisputeLifecycle(env);
  },
  fullMechanics: async (env: RuntimeState): Promise<RuntimeState> => {
    const { getScenario } = await import('../scenarios');
    const scenario = getScenario('ahb');
    if (!scenario) throw new Error('FULL_MECHANICS_SCENARIO_MISSING');
    await scenario.run(env);
    return env;
  },
};
