export type RuntimeImportAccess = 'read' | 'admin';

export type RuntimeImportAccessDecision =
  | { ok: true; access: RuntimeImportAccess }
  | { ok: false; status: 403; error: 'RUNTIME_IMPORT_ADMIN_LOCAL_ONLY' };

export const normalizeRuntimeImportAccess = (value: unknown): RuntimeImportAccess =>
  String(value || '').trim().toLowerCase() === 'admin' ? 'admin' : 'read';

export const resolveRuntimeImportAccessForRequest = (
  requestedAccess: unknown,
  fallbackAccess: RuntimeImportAccess,
  operatorAuthorized: boolean,
): RuntimeImportAccessDecision => {
  const access = normalizeRuntimeImportAccess(requestedAccess || fallbackAccess);
  if (access === 'admin' && !operatorAuthorized) {
    return { ok: false, status: 403, error: 'RUNTIME_IMPORT_ADMIN_LOCAL_ONLY' };
  }
  return { ok: true, access };
};
