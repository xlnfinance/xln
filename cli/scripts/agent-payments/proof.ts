import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Mppx } from 'mppx/server';
import { xlnMppServer } from '../../../core/api/payments/mpp-server';
import { safeStringify, safeParse } from '../../../core/protocol/serialization';
import { xlnMppCommandId, xlnMppMethod } from '../../../core/api/payments/mpp-method';
import { xlnX402Server } from '../../../core/api/payments/x402';
import type { StorageAccountDoc } from '../../../core/storage/types';
import type { RuntimeAdapterFrameReceiptResponse } from '../../../core/api/runtime-adapter/types';
import { connectParticipant } from './connection';
import { deriveDelta } from '../../../core/account/utils';

const output = process.argv[2];
assert(output, 'PROOF_OUTPUT_REQUIRED');
const started = performance.now();
const sourceSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
const sourceDirty = Bun.spawnSync(['git', 'status', '--porcelain']).stdout.toString().trim().length > 0;
mkdirSync(output, { recursive: true, mode: 0o700 });
const holderPath = '.xln-stand-lock/slot-0/holder.json';
const holder = readFileSync(holderPath, 'utf8');
assert(JSON.parse(holder).reason === 'dev', 'EXISTING_DEV_STAND_REQUIRED');
// This is a client of the already locked dev stand. It starts no Runtime or chain.
const payer = await connectParticipant('H2');
const merchant = await connectParticipant('H3');
const snapshot = async () => {
  const a = await payer.adapter.read<StorageAccountDoc>(`entity/${payer.entityId}/account/${merchant.entityId}`);
  const b = await merchant.adapter.read<StorageAccountDoc>(`entity/${merchant.entityId}/account/${payer.entityId}`);
  const ad = a.state.deltas.get(1),
    bd = b.state.deltas.get(1);
  assert(ad && bd, 'TOKEN_MISSING');
  return {
    payer: ad,
    merchant: bd,
    payerCapacity: deriveDelta(ad, payer.entityId < merchant.entityId).outCapacity,
    merchantCapacity: deriveDelta(bd, merchant.entityId < payer.entityId).outCapacity,
    payerHeight: a.currentHeight,
    merchantHeight: b.currentHeight,
  };
};
const invoicePath = join(output, 'invoice.json');
const initial = {
  before: await snapshot(),
  payerStart: payer.adapter.currentHeight + 1,
  order: {
    amount: '1000000',
    currency: merchant.currency,
    recipient: merchant.entityId,
    orderId: `local-mpp-${crypto.randomUUID()}`,
    fromHeight: merchant.adapter.currentHeight + 1,
  },
  realm: 'xln.local-proof',
};
const { before, payerStart, order, realm } = existsSync(invoicePath)
  ? (safeParse(readFileSync(invoicePath, 'utf8')) as typeof initial)
  : initial;
xlnMppMethod.schema.request.parse(order);
assert(realm === initial.realm && order.recipient === merchant.entityId && order.currency === merchant.currency);
if (!existsSync(invoicePath)) writeFileSync(invoicePath, safeStringify(initial, 2), { mode: 0o600, flag: 'wx' });
const mpp = Mppx.create({
  realm,
  secretKey: crypto.randomUUID(),
  methods: [
    xlnMppServer({
      adapter: merchant.adapter,
      recipient: merchant.entityId,
      currency: merchant.currency,
    }),
  ],
});
let paidRequests = 0;
let loseResponse = true;
const x402 = xlnX402Server({
  realm,
  secretKey: crypto.randomUUID(),
  adapter: merchant.adapter,
  recipient: merchant.entityId,
  currency: merchant.currency,
});
const http = createServer(async (req, res) => {
  try {
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      headers: req.headers as Record<string, string>,
    });
    if (req.url?.endsWith('/x402')) {
      const response = await x402(order, request, () =>
        Response.json({ orderId: order.orderId, resource: 'paid research result' }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    const result = await mpp.charge(order)(request);
    if (result.status === 200) paidRequests++;
    if (result.status === 200 && loseResponse) {
      // Destroy TCP after verification, before writing any HTTP response bytes.
      req.socket.destroy();
      return;
    }
    const response =
      result.status === 402
        ? result.challenge
        : result.withReceipt(Response.json({ orderId: order.orderId, resource: 'paid research result' }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    console.error(error);
    res.destroy();
  }
});
http.listen(0, '127.0.0.1');
await once(http, 'listening');
const address = http.address();
assert(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/invoice`;
const configPath = join(output, 'client.json');
writeFileSync(
  configPath,
  safeStringify({
    realm,
    recipient: merchant.entityId,
    invoice: invoicePath,
    store: join(output, 'intents.sqlite'),
    url,
  }),
  { mode: 0o600 },
);
const runClient = async (name: string, protocol = 'mpp') => {
  const proc = Bun.spawn(['bun', 'cli/scripts/agent-payments/payer.ts', configPath, protocol], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  writeFileSync(join(output, `${name}.log`), stdout + stderr);
  console.log(name, exit, stdout.trim(), stderr.slice(-900));
  return { exit, pid: proc.pid };
};
try {
  const unpaid = await fetch(url);
  assert.equal(unpaid.status, 402);
  const lost = await runClient('lost-response');
  assert.equal(lost.exit, 1);
  assert(paidRequests >= 1, 'failure must be after verified payment');
  loseResponse = false;
  const afterFirst = await snapshot();
  assert.equal(before.payerCapacity - afterFirst.payerCapacity, BigInt(order.amount));
  assert.equal(afterFirst.merchantCapacity - before.merchantCapacity, BigInt(order.amount));
  assert.equal(afterFirst.payer.offdelta, afterFirst.merchant.offdelta);
  const retry = await runClient('restarted-client');
  assert.equal(retry.exit, 0);
  assert.notEqual(retry.pid, lost.pid);
  assert.deepEqual(await snapshot(), afterFirst, 'retry changed the bilateral Account');
  assert(paidRequests >= 2);
  assert.equal((await fetch(`${url}/x402`)).status, 402);
  const x402Retry = await runClient('x402-client', 'x402');
  assert.equal(x402Retry.exit, 0);
  assert.deepEqual(await snapshot(), afterFirst, 'x402 retry charged the same invoice twice');
  const mcpRetry = await runClient('mcp-client', 'mcp');
  assert.equal(mcpRetry.exit, 0);
  assert.deepEqual(await snapshot(), afterFirst, 'MCP retry charged the same invoice twice');
  const events = async (participant: typeof payer, fromHeight: number, names: string[]) => {
    const result = [];
    const head = participant.adapter.currentHeight;
    while (fromHeight <= head) {
      const page = await participant.adapter.read<RuntimeAdapterFrameReceiptResponse>('frame-receipts', {
        fromHeight,
        toHeight: head,
        entityId: participant.entityId,
        eventNames: names,
        limit: 500,
      });
      assert(page.toHeight >= fromHeight, 'NON_ADVANCING_RECEIPTS');
      for (const frame of page.receipts)
        for (const log of frame.logs) {
          if (log.data?.['description'] === `xln-agent:${xlnMppCommandId(realm, order)}`) {
            result.push({
              height: frame.height,
              event: log.message,
              amount: log.data['amount'],
              hashlock: log.data['hashlock'],
            });
          }
        }
      fromHeight = page.toHeight + 1;
    }
    return result;
  };
  const sent = await events(payer, payerStart, ['HtlcInitiated', 'HtlcFinalized']);
  const received = await events(merchant, order.fromHeight, ['HtlcReceived']);
  assert.equal(sent.filter(e => e.event === 'HtlcInitiated').length, 1);
  assert.equal(sent.filter(e => e.event === 'HtlcFinalized').length, 1);
  assert.equal(received.length, 1);
  assert.equal(afterFirst.payer.collateral, before.payer.collateral);
  assert.equal(afterFirst.merchant.collateral, before.merchant.collateral);
  assert.equal(readFileSync(holderPath, 'utf8'), holder, 'stand ownership changed');
  const evidence = {
    sourceSha,
    sourceDirty,
    runtimeProvenance: 'Existing locked dev stand; not restarted or rebuilt by this proof',
    elapsedMs: performance.now() - started,
    order,
    before,
    afterFirst,
    lost,
    retry,
    x402Retry,
    mcpRetry,
    paidRequests,
    sent,
    received,
  };
  writeFileSync(join(output, 'result.json'), safeStringify(evidence, 2));
  console.log('MPP_PROOF_PASSED', output);
} finally {
  http.closeAllConnections();
  http.close();
  payer.adapter.disconnect();
  merchant.adapter.disconnect();
}
