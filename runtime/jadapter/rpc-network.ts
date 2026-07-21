export type RpcChainIdReader = {
  send(method: string, params: readonly unknown[]): Promise<unknown>;
};

export const readAndAssertRpcChainId = async (
  provider: RpcChainIdReader,
  configuredChainId: number,
): Promise<number> => {
  const raw = await provider.send('eth_chainId', []);
  const actualChainId = Number(BigInt(String(raw)));
  if (actualChainId !== Number(configuredChainId)) {
    throw new Error(
      `[JAdapter:rpc] chainId mismatch: config=${configuredChainId} rpc=${actualChainId}. Refusing to sign/submit.`,
    );
  }
  return actualChainId;
};
