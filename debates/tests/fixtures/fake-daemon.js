const port = Number(Bun.argv[2] || '18117');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('fake-daemon');
  },
  websocket: {
    message(ws, message) {
      const request = JSON.parse(String(message));
      let data;
      if (request.type === 'get_frame_receipts') {
        data = { fromHeight: 1, toHeight: 0, returned: 0, receipts: [] };
      } else if (request.type === 'find_routes') {
        data = {
          routes: [{
            path: [request.sourceEntityId, request.targetEntityId].filter(Boolean),
            hops: [],
            totalFee: '0',
            senderAmount: String(request.amount || '0'),
            recipientAmount: String(request.amount || '0'),
            probability: 1,
          }],
        };
      } else if (request.type === 'queue_payment') {
        data = {
          sourceEntityId: request.sourceEntityId,
          signerId: 'fake-signer',
          targetEntityId: request.targetEntityId,
          tokenId: request.tokenId,
          amount: request.amount,
          route: request.route || [request.sourceEntityId, request.targetEntityId].filter(Boolean),
          mode: 'htlc',
          description: request.description,
          startedAtMs: request.startedAtMs,
          hashlock: `fake_hashlock_${Date.now()}`,
        };
      } else {
        ws.send(JSON.stringify({ inReplyTo: request.id, error: `Unsupported fake daemon RPC: ${request.type}` }));
        return;
      }
      ws.send(JSON.stringify({ inReplyTo: request.id, data }));
    },
  },
});

console.log(`[fake-daemon] listening ws://127.0.0.1:${server.port}/rpc`);

process.on('SIGTERM', () => server.stop(true));
process.on('SIGINT', () => server.stop(true));
