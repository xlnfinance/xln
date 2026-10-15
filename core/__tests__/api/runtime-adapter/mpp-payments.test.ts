import { expect, test } from 'bun:test';
import { Challenge, Credential, Store } from 'mppx';
import { Mppx, Transport } from 'mppx/server';
import { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';
import { xlnMppClient } from '../../../api/payments/mpp-client';
import { xlnMppServer } from '../../../api/payments/mpp-server';
import { xlnMppCommandId, xlnMppMethod } from '../../../api/payments/mpp-method';
import { xlnX402Client, xlnX402Server } from '../../../api/payments/x402';
import { decodePaymentRequiredHeader } from '@x402/core/http';

const recipient = `0x${'11'.repeat(32)}`;
const currency = `xln:eip155:11155111/depository:0x${'22'.repeat(20)}/token:1`;
const order = { amount: '1000', currency, recipient, orderId: 'merchant-order-0001', fromHeight: 1 };
const realm = 'merchant.example';
const adapter = new RemoteRuntimeAdapter();
const server = Mppx.create({
  secretKey: 'mpp-test-only-hmac-key-32-bytes-long',
  realm,
  methods: [xlnMppServer({ adapter, recipient, currency })],
});
const handle = server.charge(order);
const url = `https://${realm}/invoice/${order.orderId}`;

test('the real MPP SDK advertises the XLN charge method and exact invoice terms', async () => {
  const result = await handle(new Request(url));
  expect(result.status).toBe(402);
  if (result.status !== 402) throw new Error('Expected an unpaid challenge');
  const challenge = Challenge.fromResponse(result.challenge);
  expect(challenge.method).toBe('xln');
  expect(challenge.intent).toBe('charge');
  expect(challenge.request).toEqual(order);
});

test('the real MPP SDK rejects a modified price rather than accepting a claimed payment', async () => {
  const result = await handle(new Request(url));
  if (result.status !== 402) throw new Error('Expected an unpaid challenge');
  const issued = Challenge.fromResponse(result.challenge);
  const authorization = Credential.serialize({
    challenge: { ...issued, request: { ...issued.request, amount: '1' } },
    payload: { hashlock: `0x${'33'.repeat(32)}` },
  });
  expect((await handle(new Request(url, { headers: { Authorization: authorization } }))).status).toBe(402);
});

test('a payer-supplied hashlock without merchant runtime evidence never grants access', async () => {
  const result = await handle(new Request(url));
  if (result.status !== 402) throw new Error('Expected an unpaid challenge');
  const authorization = Credential.serialize({
    challenge: Challenge.fromResponse(result.challenge),
    payload: { hashlock: `0x${'33'.repeat(32)}` },
  });
  expect((await handle(new Request(url, { headers: { Authorization: authorization } }))).status).toBe(402);
});

test.each([
  ['orderId', { ...order, orderId: 'merchant-order-0002' }],
  ['fromHeight', { ...order, fromHeight: 2 }],
] as const)('an issued credential cannot cross an invoice %s boundary', async (field, otherOrder) => {
  const issued = await handle(new Request(url));
  if (issued.status !== 402) throw new Error('Expected an unpaid challenge');
  const authorization = Credential.serialize({
    challenge: Challenge.fromResponse(issued.challenge),
    payload: { hashlock: `0x${'33'.repeat(32)}` },
  });
  const result = await server.charge(otherOrder)(new Request(url, { headers: { Authorization: authorization } }));
  expect(result.status).toBe(402);
  if (result.status !== 402) throw new Error('Cross-order credential was accepted');
  // Distinguishes binding rejection from the disconnected runtime rejection below it.
  expect(await result.challenge.text()).toContain(`credential ${field} does not match`);
});

test('fresh challenges for the same order retain the command id; merchant and order changes do not', () => {
  const first = xlnMppCommandId(realm, order);
  expect(xlnMppCommandId(realm, { ...order, fromHeight: 2 })).toBe(first);
  expect(xlnMppCommandId('other.example', order)).not.toBe(first);
  expect(xlnMppCommandId(realm, { ...order, orderId: 'merchant-order-0002' })).not.toBe(first);
  expect(xlnMppCommandId(realm, { ...order, recipient: `0x${'44'.repeat(32)}` })).not.toBe(first);
});

test('the client rejects an unapproved merchant before using the runtime', async () => {
  const client = xlnMppClient({
    adapter,
    realm,
    recipient,
    currency,
    maxDebit: '1100',
    entityId: `0x${'55'.repeat(32)}`,
    signerId: `0x${'66'.repeat(20)}`,
    intents: Store.memory(),
  });
  const challenge = Challenge.from(
    { id: 'test-unknown-merchant', method: 'xln', intent: 'charge', realm: 'other.example', request: order },
    { methods: [xlnMppMethod] },
  );
  await expect(client.createCredential({ challenge })).rejects.toThrow('MPP_XLN_OFFER_NOT_AUTHORIZED');
});

test('x402 advertises an explicit upfront XLN scheme, not an EVM exact transfer', async () => {
  const serve = xlnX402Server({
    adapter,
    recipient,
    currency,
    realm,
    secretKey: 'test-x402-secret-for-tests-32-bytes',
  });
  const response = await serve(order, new Request(url), () => {
    throw new Error('UNPAID_ACCESS');
  });
  expect(response.status).toBe(402);
  const header = response.headers.get('PAYMENT-REQUIRED');
  if (!header) throw new Error('Missing x402 challenge');
  const required = decodePaymentRequiredHeader(header);
  const accepted = required.accepts[0];
  if (!accepted) throw new Error('Missing payment requirements');
  expect(accepted).toMatchObject({
    scheme: 'xln',
    network: 'eip155:11155111',
    asset: currency,
    amount: order.amount,
    payTo: recipient,
    extra: { paymentFlow: 'upfront' },
  });
  const client = xlnX402Client({
    adapter,
    recipient,
    currency,
    realm,
    maxDebit: '1100',
    entityId: `0x${'55'.repeat(32)}`,
    signerId: `0x${'66'.repeat(20)}`,
    intents: Store.memory(),
  });
  await expect(client.createPaymentPayload(2, { ...accepted, amount: '1' })).rejects.toThrow('X402_XLN_TERMS_MISMATCH');
  await expect(client.createPaymentPayload(1, accepted)).rejects.toThrow('X402_XLN_VERSION_UNSUPPORTED');
  const invalid = await serve(order, new Request(url, { headers: { 'PAYMENT-SIGNATURE': 'invalid' } }), () => {
    throw new Error('UNVERIFIED_ACCESS');
  });
  expect(invalid.status).toBe(402);
});

test('MCP uses the same XLN invoice through the SDK transport', async () => {
  const server = Mppx.create({
    realm,
    secretKey: 'test-mcp-secret-for-tests-32-bytes',
    transport: Transport.mcp(),
    methods: [xlnMppServer({ adapter, recipient, currency })],
  });
  const result = await server.charge(order)({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'paid_research' },
  });
  expect(result.status).toBe(402);
  if (result.status !== 402) throw new Error('UNPAID_MCP_ACCESS');
  expect(result.challenge.error?.code).toBe(-32042);
  expect(result.challenge.error?.data?.challenges[0]?.request).toEqual(order);
});
