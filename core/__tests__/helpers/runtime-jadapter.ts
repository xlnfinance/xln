import { createServer } from 'node:net';
import { startAnvil, stopAnvil, waitForRpcReady } from '../../scripts/operations/settlement/rpc-settlement-anvil';

const reservePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('RUNTIME_JADAPTER_PORT_MISSING'));
      return;
    }
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

export const startRuntimeAdapterRpc = async () => {
  const port = await reservePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = await startAnvil({ chainId: 31337, port });
  try {
    await waitForRpcReady(rpcUrl);
    return { rpcUrl, close: () => stopAnvil(anvil, false) };
  } catch (error) {
    await stopAnvil(anvil, false);
    throw error;
  }
};
