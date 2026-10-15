import { Method, z } from 'mppx';
import { keccak256, toUtf8Bytes } from 'ethers';
import { safeStringify } from '../../protocol/serialization';
import type { RuntimeAdapter } from '../runtime-adapter/types';
import type { RuntimeAdapterEntityCoreDoc } from '../runtime-adapter/read/context';

// Experimental custom MPP method. The asset identifier binds one registry token to its exact J.
const currencyPattern = /^xln:eip155:([1-9]\d*)\/depository:(0x[\da-f]{40})\/token:([1-9]\d*)$/;
export const xlnMppMethod = Method.from({
  name: 'xln',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ hashlock: z.hash() }) },
    request: z.object({
      amount: z.string().check(z.regex(/^[1-9]\d{0,77}$/)),
      currency: z.string().check(z.regex(currencyPattern)),
      recipient: z.hash(),
      orderId: z.string().check(z.minLength(16), z.maxLength(128)),
      // Receiver's committed head when this application order was created. Reuse on retries.
      fromHeight: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)),
    }),
  },
});

export type XlnMppRequest = z.infer<typeof xlnMppMethod.schema.request>;

/** Same merchant order keeps its command id across fresh HTTP challenges and lost responses. */
export const xlnMppCommandId = (realm: string, request: XlnMppRequest): string =>
  `mpp:${keccak256(toUtf8Bytes(safeStringify([realm, request.recipient.toLowerCase(), request.orderId]))).slice(2)}`;

export const requireXlnMppCurrency = async (
  adapter: RuntimeAdapter,
  entityId: string,
  currency: string,
): Promise<number> => {
  const match = currencyPattern.exec(currency);
  if (!match) throw new Error('MPP_XLN_CURRENCY_INVALID');
  const [, chainId, depository, token] = match;
  const tokenId = Number(token);
  if (!Number.isSafeInteger(tokenId) || tokenId < 1 || tokenId > 65535) throw new Error('MPP_XLN_TOKEN_INVALID');
  const core = await adapter.read<RuntimeAdapterEntityCoreDoc>(`entity/${entityId}`);
  const domain = core.config.jurisdiction;
  if (!domain || String(domain.chainId) !== chainId || domain.depositoryAddress?.toLowerCase() !== depository) {
    throw new Error('MPP_XLN_JURISDICTION_MISMATCH');
  }
  return tokenId;
};
