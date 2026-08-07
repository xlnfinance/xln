import { safeStringify } from '../protocol/serialization';
import {
  assertOrchestratorResetAllowed,
  ORCHESTRATOR_RESET_CONFIRMATION,
  OrchestratorResetRejectedError,
  type OrchestratorResetBody,
} from './reset-guard';
import type { AggregatedHealth } from './orchestrator-types';

export type ResetHttpDeps = {
  resetAllowed: boolean;
  bindHost: string;
  resetToken: string;
  mmEnabled: boolean;
  custodyEnabled: boolean;
  ensureResetWithOptions: (options: {
    enableMarketMaker: boolean;
    enableCustody: boolean;
  }) => Promise<unknown>;
  pollAllHubHealth: () => Promise<void>;
  pollMarketMakerHealth: () => Promise<void>;
  buildAggregatedHealthResponse: () => Promise<AggregatedHealth>;
  serializeError: (error: unknown) => string;
};

export const handleResetHttpRequest = async (
  request: Request,
  pathname: string,
  operatorAuthorized: boolean,
  headers: Record<string, string>,
  deps: ResetHttpDeps,
): Promise<Response | null> => {
  if (pathname !== '/api/reset' || request.method !== 'POST') return null;
  try {
    const body = await request
      .json()
      .catch(() => null) as OrchestratorResetBody | null;
    assertOrchestratorResetAllowed(request, body, {
      resetAllowed: deps.resetAllowed,
      operatorAuthorized,
      bindHost: deps.bindHost,
      resetToken: deps.resetToken,
    });
    const requestedMarketMaker =
      body?.enableMarketMaker ?? body?.requireMarketMaker;
    const enableMarketMaker =
      typeof requestedMarketMaker === 'boolean'
        ? requestedMarketMaker
        : deps.mmEnabled;
    const requestedCustody = body?.enableCustody ?? body?.requireCustody;
    const enableCustody =
      typeof requestedCustody === 'boolean'
        ? requestedCustody
        : deps.custodyEnabled;
    await deps.ensureResetWithOptions({ enableMarketMaker, enableCustody });
    await deps.pollAllHubHealth();
    if (enableMarketMaker) await deps.pollMarketMakerHealth();
    return new Response(
      safeStringify(await deps.buildAggregatedHealthResponse()),
      { headers },
    );
  } catch (error) {
    if (error instanceof OrchestratorResetRejectedError) {
      return new Response(
        safeStringify({
          error: error.code,
          ...(error.code === 'RESET_CONFIRMATION_REQUIRED'
            ? { requiredConfirmation: ORCHESTRATOR_RESET_CONFIRMATION }
            : {}),
        }),
        { status: error.status, headers },
      );
    }
    let health: AggregatedHealth | null = null;
    let healthError: string | null = null;
    try {
      health = await deps.buildAggregatedHealthResponse();
    } catch (healthBuildError) {
      healthError = deps.serializeError(healthBuildError);
    }
    return new Response(
      safeStringify({
        error: deps.serializeError(error),
        ...(health ? { health } : {}),
        ...(healthError ? { healthError } : {}),
      }),
      { status: 500, headers },
    );
  }
};
