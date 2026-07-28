/**
 * Canonical derived-account view for 3D visualization.
 *
 * The runtime returns bigints; every visual consumer needs numbers. This is the single
 * place that conversion happens — previously it was copy-pasted across AccountBarRenderer
 * (twice) and graph3d-visuals, which let the field lists drift apart.
 */

export interface DerivedAccountData {
  delta: number;
  totalCapacity: number;
  ownCreditLimit: number;
  peerCreditLimit: number;
  inCapacity: number;
  outCapacity: number;
  collateral: number;
  // 7-region visualization fields
  outOwnCredit: number; // our unused credit
  inCollateral: number; // our collateral
  outPeerCredit: number; // their used credit
  inOwnCredit: number; // our used credit
  outCollateral: number; // their collateral
  inPeerCredit: number; // their unused credit
}

const DERIVED_ACCOUNT_FIELDS = [
  'delta',
  'totalCapacity',
  'ownCreditLimit',
  'peerCreditLimit',
  'inCapacity',
  'outCapacity',
  'collateral',
  'outOwnCredit',
  'inCollateral',
  'outPeerCredit',
  'inOwnCredit',
  'outCollateral',
  'inPeerCredit',
] as const satisfies ReadonlyArray<keyof DerivedAccountData>;

/** Convert a runtime deriveDelta() result (bigints) into visual-space numbers. */
export function toDerivedAccountData(
  raw: Partial<Record<keyof DerivedAccountData, unknown>> | null | undefined,
): DerivedAccountData {
  const out = {} as DerivedAccountData;
  for (const field of DERIVED_ACCOUNT_FIELDS) out[field] = Number(raw?.[field] ?? 0n);
  return out;
}
