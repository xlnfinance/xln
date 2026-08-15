import { createHmac } from 'node:crypto';

const MESH_SEED_DOMAIN = 'xln:mesh-child-seed:v1';

export const requireMeshRootSeed = (env: NodeJS.ProcessEnv = process.env): string => {
  const seed = String(env['XLN_MESH_ROOT_SEED'] || env['XLN_RUNTIME_SEED'] || '').trim();
  if (!seed) {
    throw new Error('XLN_MESH_ROOT_SEED_MISSING: provision an operator seed before starting the mesh');
  }
  return seed;
};

export const deriveMeshChildSeed = (rootSeed: string, purpose: string): string => {
  const normalizedPurpose = String(purpose || '').trim().toLowerCase();
  if (!rootSeed) throw new Error('XLN_MESH_ROOT_SEED_MISSING');
  if (!normalizedPurpose) throw new Error('XLN_MESH_CHILD_SEED_PURPOSE_MISSING');
  return createHmac('sha256', rootSeed)
    .update(`${MESH_SEED_DOMAIN}|${normalizedPurpose}`)
    .digest('hex');
};

export const deriveManagedSignerSeed = (runtimeSeed: string, signerLabel: string): string => {
  const normalizedLabel = String(signerLabel || '').trim().toLowerCase();
  if (!normalizedLabel) throw new Error('XLN_MANAGED_SIGNER_LABEL_MISSING');
  return deriveMeshChildSeed(runtimeSeed, `managed-signer:${normalizedLabel}`);
};

export const deriveManagedSignerInventory = (
  runtimeSeed: string,
  signerLabels: readonly string[],
): readonly Readonly<{ seed: string; label: string }>[] => signerLabels.map(label => ({
  label,
  seed: deriveManagedSignerSeed(runtimeSeed, label),
}));

export const readMeshSeedOverrides = (
  raw: string | undefined,
  variableName: string,
): Record<string, string> => {
  const normalized = String(raw || '').trim();
  if (!normalized) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    throw new Error(`${variableName}_INVALID: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${variableName}_INVALID: expected an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const seed = typeof value === 'string' ? value.trim() : '';
    if (!seed) throw new Error(`${variableName}_INVALID: ${key} seed is empty`);
    out[key.toUpperCase()] = seed;
  }
  return out;
};

export const resolveMeshRuntimeSeed = (
  rootSeed: string,
  overrides: Readonly<Record<string, string>>,
  runtimeName: string,
): string => overrides[runtimeName.toUpperCase()] || deriveMeshChildSeed(rootSeed, `runtime:${runtimeName}`);
