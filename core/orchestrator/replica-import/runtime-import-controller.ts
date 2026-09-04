import { dirname } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { safeStringify } from '../../protocol/serialization';
import type { AggregatedHealth, CustodySupportState, HubChild, MarketMakerChild } from '../orchestrator-types';
import type { OrchestratorResetOptions } from '../process/reset-coordinator';
import { buildRuntimeImportLogLine } from './runtime-import-log';
import {
  buildCustodyRpcUrl,
  buildRuntimeImportUrl,
  buildRuntimeNodeRpcUrl,
  createRuntimeImportManifest,
  type RuntimeImportCandidate,
  type RuntimeImportManifest,
} from './runtime-import-manifest';
import { resolveRuntimeImportReadiness } from './runtime-import-readiness';

type RuntimeImportControllerDeps = {
  publicWsBaseUrl: string;
  walletUrl: string;
  custodyDaemonPort: number;
  custodyPublicRpcUrl: string;
  manifestPath: string;
  exposeUrl: boolean;
  tokenTtlMs: number;
  refreshMarginMs: number;
  hubChildren: readonly HubChild[];
  marketMakerChild: MarketMakerChild;
  getActiveResetOptions(): OrchestratorResetOptions;
  getCustodySupport(): CustodySupportState | null;
  buildAggregatedHealthResponse(): Promise<AggregatedHealth>;
  warnRefreshFailed(error: unknown): void;
};

const runtimeIdFromChild = (child: HubChild | MarketMakerChild): string =>
  String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '').trim().toLowerCase();

export const createRuntimeImportController = (deps: RuntimeImportControllerDeps) => {
  const isLoopbackPublicBase = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/.test(
    new URL(deps.publicWsBaseUrl).hostname,
  );
  const resolveWalletRuntimeImportUrl = (): string => buildRuntimeImportUrl(deps.walletUrl);

  const buildRuntimeImportManifest = (): RuntimeImportManifest | null => {
    const candidates: RuntimeImportCandidate[] = deps.hubChildren.flatMap(child => {
      if (child.engine !== 'typescript') return [];
      const runtimeId = runtimeIdFromChild(child);
      return runtimeId ? [{
        label: child.name,
        engine: 'ts',
        wsUrl: buildRuntimeNodeRpcUrl(
          deps.publicWsBaseUrl,
          isLoopbackPublicBase,
          child.apiPort,
          child.publicPort,
        ),
        authSeed: child.authSeed,
        audience: runtimeId,
        keyId: child.name.toLowerCase(),
      }] : [];
    });
    const activeResetOptions = deps.getActiveResetOptions();
    const marketMakerRuntimeId = runtimeIdFromChild(deps.marketMakerChild);
    if (activeResetOptions.enableMarketMaker && marketMakerRuntimeId) {
      candidates.push({
        label: deps.marketMakerChild.name,
        engine: 'ts',
        wsUrl: buildRuntimeNodeRpcUrl(
          deps.publicWsBaseUrl,
          isLoopbackPublicBase,
          deps.marketMakerChild.apiPort,
          deps.marketMakerChild.publicPort,
        ),
        authSeed: deps.marketMakerChild.authSeed,
        audience: marketMakerRuntimeId,
        keyId: 'mm',
      });
    }
    const custodySupport = deps.getCustodySupport();
    if (activeResetOptions.enableCustody && custodySupport?.daemonAuthSeed && custodySupport.daemonAuthAudience) {
      const custodyWsUrl = buildCustodyRpcUrl(
        deps.custodyPublicRpcUrl,
        deps.publicWsBaseUrl,
        isLoopbackPublicBase,
        deps.custodyDaemonPort,
      );
      if (custodyWsUrl) {
        candidates.push({
          label: 'Custody',
          engine: 'ts',
          wsUrl: custodyWsUrl,
          authSeed: custodySupport.daemonAuthSeed,
          audience: custodySupport.daemonAuthAudience,
          keyId: 'custody',
        });
      }
    }
    return createRuntimeImportManifest(candidates, deps.tokenTtlMs);
  };

  const clearRuntimeImportManifestFile = (): void => {
    rmSync(deps.manifestPath, { force: true });
  };

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRuntimeImportManifestRefresh = (manifest: RuntimeImportManifest | null): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delayMs = manifest
      ? Math.max(10_000, manifest.expiresAt - Date.now() - deps.refreshMarginMs)
      : 10_000;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void publishRuntimeImportManifest().catch((error) => {
        deps.warnRefreshFailed(error);
        clearRuntimeImportManifestFile();
        scheduleRuntimeImportManifestRefresh(null);
      });
    }, delayMs);
  };

  const publishRuntimeImportManifest = async (): Promise<boolean> => {
    const health = await deps.buildAggregatedHealthResponse();
    const readiness = resolveRuntimeImportReadiness(health);
    if (!readiness.ok) {
      clearRuntimeImportManifestFile();
      scheduleRuntimeImportManifestRefresh(null);
      return false;
    }
    const manifest = buildRuntimeImportManifest();
    if (!manifest) {
      clearRuntimeImportManifestFile();
      scheduleRuntimeImportManifestRefresh(null);
      return false;
    }
    const importUrl = resolveWalletRuntimeImportUrl();
    mkdirSync(dirname(deps.manifestPath), { recursive: true });
    writeFileSync(
      deps.manifestPath,
      `${safeStringify({ importUrl, manifest })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    console.log(buildRuntimeImportLogLine({
      manifest,
      importUrl,
      access: 'admin',
      manifestPath: deps.manifestPath,
      exposeUrl: deps.exposeUrl,
    }));
    scheduleRuntimeImportManifestRefresh(manifest);
    return true;
  };

  return {
    buildRuntimeImportManifest,
    clearRuntimeImportManifestFile,
    publishRuntimeImportManifest,
    resolveWalletRuntimeImportUrl,
  };
};
