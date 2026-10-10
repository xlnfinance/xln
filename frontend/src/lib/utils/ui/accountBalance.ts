import type { DerivedDelta } from '@xln/core/api/public/runtime-module';

/** Owned collateral plus the peer's debt, minus our drawn debt. Unused credit
 * and holds change spendable capacity, not ownership. deriveDelta has already
 * selected the viewer's side, including RIGHT's share of collateral. */
export const accountNetBalance = (derived: DerivedDelta): bigint => derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit;
