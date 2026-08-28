export type RuntimePaymentDeliveryMode = 'direct' | 'trusted' | 'instant' | 'async';
export type RuntimePaymentLendingTerm = '1h' | '1d' | '1m';

export type RuntimePaymentEntityTx =
  | Readonly<{
      type: 'directPayment';
      data: Readonly<{
        targetEntityId: string;
        tokenId: number;
        amount: bigint;
        route: string[];
        deliveryMode: 'direct' | 'trusted';
        trustedGatewayEntityId?: string;
        description?: string;
      }>;
    }>
  | Readonly<{
      type: 'htlcPayment';
      data: Readonly<{
        targetEntityId: string;
        tokenId: number;
        amount: bigint;
        maxSenderDebit: bigint;
        route: string[];
        deliveryMode: 'instant' | 'async';
        description?: string;
      }>;
    }>
  | Readonly<{ type: 'r2r'; data: Readonly<{ toEntityId: string; tokenId: number; amount: bigint }> }>
  | Readonly<{
      type: 'r2c';
      data: Readonly<{ counterpartyId: string; tokenId: number; amount: bigint }>;
    }>
  | Readonly<{
      type: 'settle_propose';
      data: Readonly<{
        counterpartyEntityId: string;
        ops: Array<Readonly<{ type: 'c2r'; tokenId: number; amount: bigint }>>;
        executorIsLeft: boolean;
        memo: string;
      }>;
    }>
  | Readonly<{
      type: 'lendingOffer';
      data: Readonly<{
        positionId: string;
        hubEntityId: string;
        tokenId: number;
        amount: bigint;
        termId: RuntimePaymentLendingTerm;
        interestBps: number;
      }>;
    }>
  | Readonly<{
      type: 'lendingBorrow';
      data: Readonly<{
        requestId: string;
        hubEntityId: string;
        tokenId: number;
        amount: bigint;
        termId: RuntimePaymentLendingTerm;
        maxInterestBps: number;
      }>;
    }>;

export type RuntimePaymentInput = Readonly<{
  runtimeTxs: [];
  entityInputs: Array<Readonly<{
    entityId: string;
    signerId: string;
    entityTxs: RuntimePaymentEntityTx[];
  }>>;
  jInputs: [];
}>;
