import type { ChildProcess } from 'node:child_process';
import type { MarketMakerChild, MarketMakerHealthPayload, MarketMakerInfoPayload } from './orchestrator-types';
import {
  normalizeMarketMakerHealthPayload,
  type RawMarketMakerHealthPayload,
} from './market-maker-health-payload';
import { parseRuntimeSecurityIncidentTelemetry } from './runtime-security-telemetry';

type FetchJson = <T>(url: string, timeoutMs?: number) => Promise<T | null>;

type MarketMakerChildPollerOptions = {
  child: MarketMakerChild;
  host: string;
  healthTimeoutMs: number;
  fullHealthTimeoutMs: number;
  fetchJson: FetchJson;
};

export type MarketMakerChildPoller = {
  pollHealth: () => Promise<void>;
  pollHealthOnce: () => Promise<void>;
  fetchFullHealthForResponse: () => Promise<MarketMakerHealthPayload | null>;
  isCurrentProc: (proc: ChildProcess | null) => proc is ChildProcess;
};

export const createMarketMakerChildPoller = ({
  child,
  host,
  healthTimeoutMs,
  fullHealthTimeoutMs,
  fetchJson,
}: MarketMakerChildPollerOptions): MarketMakerChildPoller => {
  let healthPollInFlight: Promise<void> | null = null;

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

  const applyHealth = (
    health: MarketMakerHealthPayload,
    proc: ChildProcess,
  ): void => {
    if (!isCurrentProc(proc)) return;
    const sanitizedHealth: MarketMakerHealthPayload = {
      ...health,
      ...(health.runtime ? {
        runtime: {
          ...health.runtime,
          securityIncidents: parseRuntimeSecurityIncidentTelemetry(health.runtime.securityIncidents),
        },
      } : {}),
    };
    child.lastHealth = sanitizedHealth;
    const nextInfo: MarketMakerInfoPayload = { ...(child.lastInfo || {}) };
    if (sanitizedHealth.name !== undefined) nextInfo.name = sanitizedHealth.name;
    if (sanitizedHealth.entityId !== undefined && sanitizedHealth.entityId !== null) nextInfo.entityId = sanitizedHealth.entityId;
    if (sanitizedHealth.runtimeId !== undefined && sanitizedHealth.runtimeId !== null) nextInfo.runtimeId = sanitizedHealth.runtimeId;
    if (sanitizedHealth.apiUrl !== undefined) nextInfo.apiUrl = sanitizedHealth.apiUrl;
    if (sanitizedHealth.relayUrl !== undefined) nextInfo.relayUrl = sanitizedHealth.relayUrl;
    if (sanitizedHealth.directWsUrl !== undefined) nextInfo.directWsUrl = sanitizedHealth.directWsUrl;
    if (sanitizedHealth.startupPhase !== undefined) {
      nextInfo.startupPhase = sanitizedHealth.startupPhase;
    }
    child.lastInfo = nextInfo;
    refreshStartupPhase();
  };

  const pollHealthOnce = async (): Promise<void> => {
    const proc = child.proc;
    if (!isCurrentProc(proc)) return;
    const health = await fetchJson<MarketMakerHealthPayload>(`${apiBase()}/api/health`, healthTimeoutMs);
    if (health) applyHealth(health, proc);
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
    const health = await fetchJson<MarketMakerHealthPayload | RawMarketMakerHealthPayload>(
      `${apiBase()}/api/health/full`,
      fullHealthTimeoutMs,
    );
    return normalizeMarketMakerHealthPayload(health);
  };

  return {
    pollHealth,
    pollHealthOnce,
    fetchFullHealthForResponse,
    isCurrentProc,
  };
};
