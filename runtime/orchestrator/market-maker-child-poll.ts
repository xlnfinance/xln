import type { ChildProcess } from 'node:child_process';
import type { MarketMakerChild, MarketMakerHealthPayload, MarketMakerInfoPayload } from './orchestrator-types';
import {
  normalizeMarketMakerHealthPayload,
  type RawMarketMakerHealthPayload,
} from './market-maker-health-payload';

type FetchJson = <T>(url: string, timeoutMs?: number) => Promise<T | null>;

type MarketMakerChildPollerOptions = {
  child: MarketMakerChild;
  host: string;
  infoTimeoutMs: number;
  healthTimeoutMs: number;
  fullHealthTimeoutMs: number;
  fetchJson: FetchJson;
};

export type MarketMakerChildPoller = {
  pollInfo: () => Promise<void>;
  pollInfoOnce: (proc?: ChildProcess | null) => Promise<boolean>;
  pollHealth: () => Promise<void>;
  pollHealthOnce: () => Promise<void>;
  fetchFullHealthForResponse: () => Promise<MarketMakerHealthPayload | null>;
  isCurrentProc: (proc: ChildProcess | null) => proc is ChildProcess;
};

export const createMarketMakerChildPoller = ({
  child,
  host,
  infoTimeoutMs,
  healthTimeoutMs,
  fullHealthTimeoutMs,
  fetchJson,
}: MarketMakerChildPollerOptions): MarketMakerChildPoller => {
  let healthPollInFlight: Promise<void> | null = null;
  let infoPollInFlight: Promise<void> | null = null;

  const apiBase = (): string => `http://${host}:${child.apiPort}`;

  const isCurrentProc = (proc: ChildProcess | null): proc is ChildProcess =>
    Boolean(
      proc &&
      child.proc === proc &&
      proc.exitCode === null &&
      child.exitCode === null &&
      child.exitSignal === null,
    );

  const refreshStartupPhase = (): void => {
    child.lastStartupPhase = String(
      child.lastInfo?.startupPhase ||
      child.lastHealth?.startupPhase ||
      '',
    ).trim() || null;
  };

  const applyInfo = (info: MarketMakerInfoPayload, proc: ChildProcess): void => {
    if (!isCurrentProc(proc)) return;
    child.lastInfo = { ...(child.lastInfo || {}), ...info };
    refreshStartupPhase();
  };

  const applyHealth = (
    health: MarketMakerHealthPayload,
    proc: ChildProcess,
    options: { trustStartupPhase: boolean },
  ): void => {
    if (!isCurrentProc(proc)) return;
    child.lastHealth = health;
    const nextInfo: MarketMakerInfoPayload = { ...(child.lastInfo || {}) };
    if (health.name !== undefined) nextInfo.name = health.name;
    if (health.entityId !== undefined && health.entityId !== null) nextInfo.entityId = health.entityId;
    if (health.runtimeId !== undefined && health.runtimeId !== null) nextInfo.runtimeId = health.runtimeId;
    if (health.apiUrl !== undefined) nextInfo.apiUrl = health.apiUrl;
    if (health.relayUrl !== undefined) nextInfo.relayUrl = health.relayUrl;
    if (health.directWsUrl !== undefined) nextInfo.directWsUrl = health.directWsUrl;
    if (health.startupPhase !== undefined && (options.trustStartupPhase || !nextInfo.startupPhase)) {
      nextInfo.startupPhase = health.startupPhase;
    }
    child.lastInfo = nextInfo;
    refreshStartupPhase();
  };

  const pollInfoOnce = async (proc: ChildProcess | null = child.proc): Promise<boolean> => {
    if (!isCurrentProc(proc)) return false;
    const info = await fetchJson<MarketMakerInfoPayload>(`${apiBase()}/api/info`, infoTimeoutMs);
    if (!info) return false;
    applyInfo(info, proc);
    return isCurrentProc(proc);
  };

  const pollInfo = async (): Promise<void> => {
    if (infoPollInFlight) return infoPollInFlight;
    const proc = child.proc;
    infoPollInFlight = pollInfoOnce(proc)
      .then(() => undefined)
      .finally(() => {
        infoPollInFlight = null;
      });
    return infoPollInFlight;
  };

  const pollHealthOnce = async (): Promise<void> => {
    const proc = child.proc;
    if (!isCurrentProc(proc)) return;
    const infoFresh = await pollInfoOnce(proc);
    if (!isCurrentProc(proc)) return;
    const health = await fetchJson<MarketMakerHealthPayload>(`${apiBase()}/api/health`, healthTimeoutMs);
    if (health) applyHealth(health, proc, { trustStartupPhase: !infoFresh });
  };

  const pollHealth = async (): Promise<void> => {
    if (healthPollInFlight) return healthPollInFlight;
    healthPollInFlight = pollHealthOnce().finally(() => {
      healthPollInFlight = null;
    });
    return healthPollInFlight;
  };

  const fetchFullHealthForResponse = async (): Promise<MarketMakerHealthPayload | null> => {
    const proc = child.proc;
    if (!isCurrentProc(proc)) return null;
    await pollInfoOnce(proc);
    if (!isCurrentProc(proc)) return null;
    const health = await fetchJson<MarketMakerHealthPayload | RawMarketMakerHealthPayload>(
      `${apiBase()}/api/health/full`,
      fullHealthTimeoutMs,
    );
    return normalizeMarketMakerHealthPayload(health);
  };

  return {
    pollInfo,
    pollInfoOnce,
    pollHealth,
    pollHealthOnce,
    fetchFullHealthForResponse,
    isCurrentProc,
  };
};
