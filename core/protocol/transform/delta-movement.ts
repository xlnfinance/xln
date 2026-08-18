/** Canonical signed Account delta movement: LEFT pays negative, RIGHT pays positive. */
export function deriveTransferOffdeltaChange(senderIsLeft: boolean, amount: bigint): bigint {
  if (amount < 0n) throw new Error(`TRANSFER_AMOUNT_NEGATIVE:${amount}`);
  return senderIsLeft ? -amount : amount;
}
