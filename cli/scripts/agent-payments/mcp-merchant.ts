import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Mppx, Transport } from 'mppx/server';
import { xlnMppServer } from '../../../core/api/payments/mpp-server';
import { xlnMppMethod } from '../../../core/api/payments/mpp-method';
import { connectParticipant } from './connection';

const path = process.argv[2];
if (!path) throw new Error('PROOF_INVOICE_REQUIRED');
const invoice = JSON.parse(readFileSync(path, 'utf8'));
const order = xlnMppMethod.schema.request.parse(invoice.order);
const merchant = await connectParticipant('H3');
const payment = Mppx.create({
  realm: invoice.realm,
  secretKey: crypto.randomUUID(),
  transport: Transport.mcpSdk(),
  methods: [xlnMppServer({ ...merchant, recipient: merchant.entityId })],
});
const server = new McpServer({ name: 'xln-paid-research', version: '0.1.0' });
server.registerTool(
  'paid_research',
  { description: 'Read the paid research result for this test invoice.' },
  async extra => {
    const result = await payment.charge(order)({ _meta: extra._meta });
    if (result.status === 402) throw result.challenge;
    return result.withReceipt({ content: [{ type: 'text', text: 'paid research result' }] });
  },
);
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => {
  merchant.adapter.disconnect();
  void server.close();
});
