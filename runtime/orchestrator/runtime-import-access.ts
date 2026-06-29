import { isLocalOperatorRequest } from '../health-redaction';

export type RuntimeImportAccess = 'read' | 'admin';

export type RuntimeImportAccessDecision =
  | { ok: true; access: RuntimeImportAccess }
  | { ok: false; status: 403; error: 'RUNTIME_IMPORT_ADMIN_LOCAL_ONLY' };

export const normalizeRuntimeImportAccess = (value: unknown): RuntimeImportAccess =>
  String(value || '').trim().toLowerCase() === 'admin' ? 'admin' : 'read';

export const resolveRuntimeImportAccessForRequest = (
  request: Request,
  requestedAccess: unknown,
  fallbackAccess: RuntimeImportAccess,
): RuntimeImportAccessDecision => {
  const access = normalizeRuntimeImportAccess(requestedAccess || fallbackAccess);
  if (access === 'admin' && !isLocalOperatorRequest(request)) {
    return { ok: false, status: 403, error: 'RUNTIME_IMPORT_ADMIN_LOCAL_ONLY' };
  }
  return { ok: true, access };
};
