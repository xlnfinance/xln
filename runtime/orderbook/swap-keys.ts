type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export type OfferId = Brand<string, 'OfferId'>;
export type SwapKey = Brand<`${string}:${string}`, 'SwapKey'>;

export function asOfferId(value: string): OfferId {
  return String(value) as OfferId;
}

export function swapKey(accountId: string, offerId: string): SwapKey {
  return `${String(accountId)}:${String(offerId)}` as SwapKey;
}

export function compareCanonicalText(left: string, right: string): number {
  const a = String(left || '');
  const b = String(right || '');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
