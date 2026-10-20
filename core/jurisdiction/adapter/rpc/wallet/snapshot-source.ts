/** A discarded read, never a balance snapshot or proof of chain ancestry. */
export type WalletSnapshotSourceAdvance = {
  code: 'TRON_SNAPSHOT_SOURCE_ADVANCED';
  previousHeight: number;
  currentHeight: number;
};

const isWalletSnapshotSourceAdvance = (value: unknown): value is WalletSnapshotSourceAdvance => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('code' in value) ||
    value.code !== 'TRON_SNAPSHOT_SOURCE_ADVANCED' ||
    !('previousHeight' in value) ||
    typeof value.previousHeight !== 'number' ||
    !('currentHeight' in value) ||
    typeof value.currentHeight !== 'number'
  )
    return false;
  return (
    Object.keys(value).length === 3 &&
    Number.isSafeInteger(value.previousHeight) &&
    Number.isSafeInteger(value.currentHeight) &&
    value.previousHeight >= 1 &&
    value.currentHeight > value.previousHeight
  );
};

export class WalletSnapshotSourceAdvancedError extends Error {
  readonly sourceAdvance: WalletSnapshotSourceAdvance;
  constructor(previousHeight: number, currentHeight: number) {
    super(`TRON_SNAPSHOT_SOURCE_CHANGED:previous=${previousHeight}:current=${currentHeight}`);
    this.sourceAdvance = { code: 'TRON_SNAPSHOT_SOURCE_ADVANCED', previousHeight, currentHeight };
    if (!isWalletSnapshotSourceAdvance(this.sourceAdvance)) throw new Error('WALLET_SNAPSHOT_SOURCE_ADVANCE_INVALID');
    this.name = 'WalletSnapshotSourceAdvancedError';
  }
}

/** Runtime and UI bundles have distinct class identities. Decode the explicit
 * disposition, never infer recoverability from an Error's message. */
export const walletSnapshotSourceAdvance = (error: unknown): WalletSnapshotSourceAdvance | null => {
  if (!error || typeof error !== 'object' || !('sourceAdvance' in error)) return null;
  return isWalletSnapshotSourceAdvance(error.sourceAdvance) ? error.sourceAdvance : null;
};
