export type OrchestratorResetOptions = Readonly<{
  enableMarketMaker: boolean;
  enableCustody: boolean;
}>;

export const resolveActiveResetOptions = (
  configured: OrchestratorResetOptions,
  completed: OrchestratorResetOptions,
): OrchestratorResetOptions => ({
  enableMarketMaker: configured.enableMarketMaker && completed.enableMarketMaker,
  enableCustody: configured.enableCustody && completed.enableCustody,
});

export const resolveResetCapabilityHealth = (
  active: OrchestratorResetOptions,
  online: Readonly<{ marketMakerOnline: boolean; custodyOnline: boolean }>,
): Readonly<{
  marketMakerEnabled: boolean;
  marketMakerActive: boolean;
  custodyEnabled: boolean;
  custodyOk: boolean;
}> => ({
  marketMakerEnabled: active.enableMarketMaker,
  marketMakerActive: active.enableMarketMaker && online.marketMakerOnline,
  custodyEnabled: active.enableCustody,
  custodyOk: !active.enableCustody || online.custodyOnline,
});

type ResetWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

const unionOptions = (
  left: OrchestratorResetOptions | null,
  right: OrchestratorResetOptions,
): OrchestratorResetOptions => ({
  enableMarketMaker: (left?.enableMarketMaker ?? false) || right.enableMarketMaker,
  enableCustody: (left?.enableCustody ?? false) || right.enableCustody,
});

const satisfies = (
  active: OrchestratorResetOptions,
  requested: OrchestratorResetOptions,
): boolean =>
  (active.enableMarketMaker || !requested.enableMarketMaker)
  && (active.enableCustody || !requested.enableCustody);

export const createResetCoordinator = (
  runReset: (options: OrchestratorResetOptions) => Promise<void>,
): { ensure: (options: OrchestratorResetOptions) => Promise<void> } => {
  let running = false;
  let pendingOptions: OrchestratorResetOptions | null = null;
  let waiters: ResetWaiter[] = [];

  const settleWaiters = (error?: unknown): void => {
    const settled = waiters;
    waiters = [];
    for (const waiter of settled) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  };

  const drain = async (): Promise<void> => {
    running = true;
    let completedOptions: OrchestratorResetOptions | null = null;
    try {
      while (pendingOptions) {
        const runOptions = unionOptions(completedOptions, pendingOptions);
        pendingOptions = null;
        await runReset(runOptions);
        completedOptions = runOptions;

        if (pendingOptions && satisfies(completedOptions, pendingOptions)) {
          pendingOptions = null;
        }
      }
      running = false;
      settleWaiters();
    } catch (error) {
      pendingOptions = null;
      running = false;
      settleWaiters(error);
    }
  };

  const ensure = (options: OrchestratorResetOptions): Promise<void> => {
    const promise = new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
    pendingOptions = unionOptions(pendingOptions, options);
    if (!running) void drain();
    return promise;
  };

  return { ensure };
};
