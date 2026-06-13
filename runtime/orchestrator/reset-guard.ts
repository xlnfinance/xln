export const ORCHESTRATOR_RESET_CONFIRMATION = 'RESET_MESH_STATE';

export type OrchestratorResetGuardConfig = {
  resetAllowed: boolean;
  bindHost: string;
  resetToken?: string;
};

export type OrchestratorResetBody = {
  confirm?: unknown;
  requireMarketMaker?: unknown;
  enableMarketMaker?: unknown;
};

export class OrchestratorResetRejectedError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'OrchestratorResetRejectedError';
    this.code = code;
    this.status = status;
  }
}

const normalizeHostName = (host: string): string => {
  const raw = String(host || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']') > 0 ? raw.indexOf(']') : undefined);
  return raw.split(':')[0] || '';
};

const isLoopbackBindHost = (host: string): boolean => {
  const normalized = normalizeHostName(host);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
};

const readBearer = (header: string | null): string => {
  const match = String(header || '').trim().match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : '';
};

const hasResetConfirmation = (request: Request, body: OrchestratorResetBody | null): boolean => {
  if (body?.confirm === ORCHESTRATOR_RESET_CONFIRMATION) return true;
  return request.headers.get('x-xln-reset-confirm') === ORCHESTRATOR_RESET_CONFIRMATION;
};

const hasResetToken = (request: Request, expectedToken: string): boolean => {
  const token = request.headers.get('x-xln-reset-token') || readBearer(request.headers.get('authorization'));
  return token === expectedToken;
};

export const assertOrchestratorResetAllowed = (
  request: Request,
  body: OrchestratorResetBody | null,
  config: OrchestratorResetGuardConfig,
): void => {
  if (!config.resetAllowed) {
    throw new OrchestratorResetRejectedError('RESET_DISABLED', 403);
  }

  if (!hasResetConfirmation(request, body)) {
    throw new OrchestratorResetRejectedError('RESET_CONFIRMATION_REQUIRED', 428);
  }

  const expectedToken = String(config.resetToken || '').trim();
  if (expectedToken) {
    if (!hasResetToken(request, expectedToken)) {
      throw new OrchestratorResetRejectedError('RESET_TOKEN_INVALID', 401);
    }
    return;
  }

  if (!isLoopbackBindHost(config.bindHost)) {
    throw new OrchestratorResetRejectedError('RESET_TOKEN_REQUIRED_FOR_PUBLIC_BIND', 403);
  }
};
