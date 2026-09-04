/**
 * Contract money ceiling (Types.sol MAX_MONEY = 1 << 200).
 *
 * Every financial magnitude the jurisdiction stores or clamps (reserve,
 * collateral, |ondelta|, |offdelta|, transformer allowance) reverts E8 above
 * 2^200. Enforce the same bound before a Runtime signs or submits anything so
 * a certified state can never be unmineable. Behavioral only: no ABI change.
 */
export const MAX_MONEY = 2n ** 200n;

export class MoneyCapExceededError extends Error {
  constructor(label: string, value: bigint) {
    super(`MONEY_CAP_EXCEEDED:${label}:${value.toString()}`);
    this.name = 'MoneyCapExceededError';
  }
}

/** Unsigned amount: 0 ≤ value ≤ MAX_MONEY. */
export const assertMoneyAmount = (value: bigint, label: string): bigint => {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_MONEY) {
    throw new MoneyCapExceededError(label, value);
  }
  return value;
};

/** Signed magnitude: |value| ≤ MAX_MONEY. */
export const assertMoneyMagnitude = (value: bigint, label: string): bigint => {
  if (typeof value !== 'bigint' || value > MAX_MONEY || value < -MAX_MONEY) {
    throw new MoneyCapExceededError(label, value);
  }
  return value;
};
