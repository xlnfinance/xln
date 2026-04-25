type BunServerLike = {
  stop: (closeActiveConnections?: boolean) => void;
};

export type HttpDrainTracker = {
  begin: () => () => void;
  active: () => number;
  waitForIdle: (timeoutMs: number) => Promise<boolean>;
};

export const createHttpDrainTracker = (): HttpDrainTracker => {
  let active = 0;
  const waiters = new Set<() => void>();

  const notifyIfIdle = (): void => {
    if (active !== 0) return;
    for (const resolve of Array.from(waiters)) {
      waiters.delete(resolve);
      resolve();
    }
  };

  return {
    begin: () => {
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        notifyIfIdle();
      };
    },
    active: () => active,
    waitForIdle: async (timeoutMs: number): Promise<boolean> => {
      if (active === 0) return true;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(onIdle);
          resolve(ok);
        };
        const onIdle = () => finish(true);
        const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        waiters.add(onIdle);
        notifyIfIdle();
      });
    },
  };
};

export const stopServerGracefully = async (
  server: BunServerLike,
  tracker: HttpDrainTracker,
  label: string,
  timeoutMs = 5_000,
): Promise<boolean> => {
  server.stop(false);
  const idle = await tracker.waitForIdle(timeoutMs);
  if (!idle) {
    console.warn(`[${label}] shutdown timed out waiting for ${tracker.active()} HTTP request(s); closing active connections`);
    server.stop(true);
  }
  return idle;
};
