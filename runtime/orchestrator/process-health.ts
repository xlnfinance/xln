import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { AggregatedHealth, HubChild, ManagedRuntimeSpec, MarketMakerChild } from './orchestrator-types';

type ProcessLease = {
  pid: number;
  ownerId: string;
};

type ProcessHealthDeps = {
  hubChildren: HubChild[];
  marketMakerChild: MarketMakerChild;
  ownerId: string;
  managedSpecForHub(child: HubChild): ManagedRuntimeSpec;
  managedSpecForMarketMaker(): ManagedRuntimeSpec;
  readLease(spec: ManagedRuntimeSpec): ProcessLease | null;
};

/**
 * Builds observability data from live process handles and durable leases.
 *
 * A process handle says what this orchestrator currently owns. A lease says
 * what the storage layer believes owns the database. Keeping both values in
 * health output makes stale-writer incidents diagnosable instead of hiding a
 * mismatch behind one synthetic "online" flag.
 */
export const createProcessHealthBuilder = (deps: ProcessHealthDeps) => {
  const buildChildProcessHealth = (): AggregatedHealth['process']['children'] => {
    const hubEntries = deps.hubChildren.map(child => {
      const spec = deps.managedSpecForHub(child);
      const lease = deps.readLease(spec);
      return {
        role: spec.role,
        name: spec.name,
        pid: child.proc?.pid ?? null,
        leasePid: lease?.pid ?? null,
        leaseOwnerId: lease?.ownerId ?? null,
        online:
          child.proc?.exitCode === null &&
          child.proc?.signalCode === null &&
          child.lastHealth?.runtime?.halted !== true,
        exitCode: child.exitCode,
        exitSignal: child.exitSignal,
        startedAt: child.startedAt,
        exitedAt: child.exitedAt,
        restartCount: child.restartCount,
        apiPort: spec.apiPort,
        dbPath: spec.dbPath,
        lastErrorLine: child.recentStderr.at(-1) ?? null,
        recentStdout: child.recentStdout.slice(-10),
        recentStderr: child.recentStderr.slice(-10),
      };
    });

    const spec = deps.managedSpecForMarketMaker();
    const lease = deps.readLease(spec);
    const child = deps.marketMakerChild;
    return [
      ...hubEntries,
      {
        role: spec.role,
        name: spec.name,
        pid: child.proc?.pid ?? null,
        leasePid: lease?.pid ?? null,
        leaseOwnerId: lease?.ownerId ?? null,
        online:
          child.proc?.exitCode === null &&
          child.proc?.signalCode === null &&
          child.lastHealth?.runtime?.halted !== true,
        exitCode: child.exitCode,
        exitSignal: child.exitSignal,
        startedAt: child.startedAt,
        exitedAt: child.exitedAt,
        restartCount: child.restartCount,
        apiPort: spec.apiPort,
        dbPath: spec.dbPath,
        lastErrorLine: child.recentStderr.at(-1) ?? null,
        recentStdout: child.recentStdout.slice(-10),
        recentStderr: child.recentStderr.slice(-10),
      },
    ];
  };

  return (): AggregatedHealth['process'] => {
    const memory = process.memoryUsage();
    const totalMemory = totalmem();
    const freeMemory = freemem();
    return {
      pid: process.pid,
      ownerId: deps.ownerId,
      uptimeSec: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      loadavg: loadavg(),
      cpuCount: cpus().length,
      memory: {
        freeBytes: freeMemory,
        totalBytes: totalMemory,
        freePct: totalMemory > 0 ? Math.round((freeMemory / totalMemory) * 10_000) / 100 : 0,
      },
      children: buildChildProcessHealth(),
    };
  };
};
