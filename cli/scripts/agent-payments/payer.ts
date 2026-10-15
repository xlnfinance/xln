import { readFileSync } from 'node:fs';
import { Mppx } from 'mppx/client';
import { xlnMppClient } from '../../../core/api/payments/mpp-client';
import { paymentIntentStore } from '../../lib/agent-payments/intent-store';
import { connectParticipant } from './connection';
import { safeStringify } from '../../../core/protocol/serialization';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { xlnX402Client } from '../../../core/api/payments/x402';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpClient } from 'mppx/mcp/client';

const path = process.argv[2];
if (!path) throw new Error('PROOF_CONFIG_REQUIRED');
const config = JSON.parse(readFileSync(path, 'utf8'));
const payer = await connectParticipant('H2');
const persistence = paymentIntentStore(config.store);
try {
  const options = {
    ...payer,
    realm: config.realm,
    recipient: config.recipient,
    maxDebit: '2000000',
    intents: persistence.store,
  };
  const protocol = process.argv[3] ?? 'mpp';
  if (protocol === 'mcp') {
    const client = new Client({ name: 'xln-proof-agent', version: '0.1.0' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['cli/scripts/agent-payments/mcp-merchant.ts', config.invoice],
        }),
      );
      const paid = McpClient.wrap(client, { methods: [xlnMppClient(options)] });
      const result = await paid.callTool({ name: 'paid_research' });
      if (!result.receipt || !safeStringify(result.content).includes('paid research result'))
        throw new Error('PROOF_MCP_ACCESS_FAILED');
      console.log(safeStringify({ protocol, result, pid: process.pid }));
    } finally {
      await client.close();
    }
  } else {
    const payFetch =
      protocol === 'x402'
        ? wrapFetchWithPaymentFromConfig(fetch, {
            schemes: [{ network: 'eip155:31337', client: xlnX402Client(options) }],
            spendControls: {
              allowedAssets: [
                { network: 'eip155:31337', asset: payer.currency, maxAmountPerPayment: options.maxDebit },
              ],
            },
          })
        : Mppx.create({ methods: [xlnMppClient(options)], polyfill: false }).fetch;
    const response = await payFetch(protocol === 'x402' ? `${config.url}/x402` : config.url);
    const body = await response.text();
    if (response.status !== 200) throw new Error(`PROOF_HTTP_${response.status}:${body}`);
    if (!response.headers.get('Payment-Receipt') || !body.includes('paid research result')) {
      throw new Error('PROOF_RESPONSE_LOST');
    }
    console.log(
      safeStringify({
        status: response.status,
        body,
        receipt: response.headers.get('Payment-Receipt'),
        pid: process.pid,
      }),
    );
    if (protocol === 'x402' && !response.headers.get('PAYMENT-RESPONSE')) throw new Error('PROOF_X402_RECEIPT_MISSING');
  }
} finally {
  payer.adapter.disconnect();
  persistence.close();
}
