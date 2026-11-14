import { assertArgument } from 'ethers';

export type RpcChainIdReader = {
  send(method: string, params: readonly unknown[]): Promise<unknown>;
};

export const readAndAssertRpcChainId = async (
  provider: RpcChainIdReader,
  configuredChainId: number,
): Promise<number> => {
  const raw = await provider.send('eth_chainId', []);
  const actualChainId = Number(BigInt(String(raw)));
  assertArgument(
    actualChainId === Number(configuredChainId),
    `[JAdapter:rpc] chainId mismatch: config=${configuredChainId} rpc=${actualChainId}. Refusing to sign/submit.`,
    'chainId',
    configuredChainId,
  );
  return actualChainId;
};
