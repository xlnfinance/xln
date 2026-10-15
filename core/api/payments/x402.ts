import { Challenge, Receipt } from 'mppx';
import { Mppx } from 'mppx/server';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { Network, PaymentRequired, PaymentRequirements, SchemeNetworkClient } from '@x402/core/types';
import { PaymentPayloadV2Schema } from '@x402/core/schemas';
import { xlnMppClient } from './mpp-client';
import { xlnMppServer } from './mpp-server';
import { xlnMppMethod, type XlnMppRequest } from './mpp-method';
import { safeStringify } from '../../protocol/serialization';

const requirements = (challenge: Challenge.Challenge): PaymentRequirements => {
  const order = xlnMppMethod.schema.request.parse(challenge.request);
  const network: Network = `eip155:${order.currency.slice('xln:eip155:'.length).split('/')[0]}`;
  return {
    scheme: 'xln',
    network,
    asset: order.currency,
    amount: order.amount,
    payTo: order.recipient,
    maxTimeoutSeconds: 30,
    extra: { paymentFlow: 'upfront', mppChallenge: challenge },
  };
};

/** Experimental x402 scheme. Register explicitly; ordinary EVM exact facilitators cannot settle XLN. */
export const xlnX402Client = (options: Parameters<typeof xlnMppClient>[0]): SchemeNetworkClient => ({
  scheme: 'xln',
  async createPaymentPayload(version, accepted) {
    if (version !== 2) throw new Error('X402_XLN_VERSION_UNSUPPORTED');
    const challenge = Challenge.from(Challenge.Schema.parse(accepted.extra['mppChallenge']), {
      methods: [xlnMppMethod],
    });
    if (safeStringify(accepted) !== safeStringify(requirements(challenge))) {
      throw new Error('X402_XLN_TERMS_MISMATCH');
    }
    // Same invoice, intent store and Paybook path across MPP, x402 and MCP retries.
    const credential = await xlnMppClient(options).createCredential({ challenge });
    return { x402Version: 2, payload: { credential } };
  },
});

/** Fetch-compatible middleware, using the official x402 codecs and the canonical MPP verifier. */
export const xlnX402Server = (options: Parameters<typeof xlnMppServer>[0] & { realm: string; secretKey: string }) => {
  const mpp = Mppx.create({ realm: options.realm, secretKey: options.secretKey, methods: [xlnMppServer(options)] });
  return async (
    order: XlnMppRequest,
    request: Request,
    resource: () => Promise<Response> | Response,
  ): Promise<Response> => {
    const handle = mpp.charge(order);
    const unpaid = await handle(new Request(request.url));
    if (unpaid.status !== 402) throw new Error('X402_XLN_CHALLENGE_MISSING');
    const challenge = Challenge.fromResponse(unpaid.challenge);
    const accepted = requirements(challenge);
    const required: PaymentRequired = { x402Version: 2, resource: { url: request.url }, accepts: [accepted] };
    const reject = (error?: string) =>
      Response.json(
        { ...required, ...(error ? { error } : {}) },
        {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required), 'Cache-Control': 'no-store' },
        },
      );
    const signature = request.headers.get('PAYMENT-SIGNATURE');
    if (!signature) return reject();
    let payload;
    try {
      payload = PaymentPayloadV2Schema.parse(decodePaymentSignatureHeader(signature));
      if (!payload.accepted.extra) return reject('X402_XLN_PAYLOAD_INVALID');
      const echoed = Challenge.Schema.parse(payload.accepted.extra['mppChallenge']);
      if (
        safeStringify(payload.accepted) !== safeStringify(requirements(echoed)) ||
        safeStringify(echoed.request) !== safeStringify(order) ||
        echoed.realm !== options.realm
      ) {
        return reject('X402_XLN_TERMS_MISMATCH');
      }
    } catch {
      return reject('X402_XLN_PAYLOAD_INVALID');
    }
    if (payload.x402Version !== 2 || typeof payload.payload?.['credential'] !== 'string') {
      return reject('X402_XLN_PAYLOAD_INVALID');
    }
    // The embedded HMAC credential binds the original order. Never authorize from x402's echoed fields alone.
    const result = await handle(
      new Request(request.url, { headers: { Authorization: payload.payload['credential'] } }),
    );
    if (result.status !== 200) return reject('X402_XLN_PAYMENT_UNVERIFIED');
    const response = result.withReceipt(await resource());
    const receipt = Receipt.fromResponse(response);
    response.headers.set(
      'PAYMENT-RESPONSE',
      encodePaymentResponseHeader({
        success: true,
        transaction: receipt.reference,
        network: accepted.network,
        amount: order.amount,
        extra: { settlement: 'xln-bilateral', onchain: false },
      }),
    );
    return response;
  };
};
