import { ethers } from 'ethers';
import type { JAdapter } from '../jadapter';

const STACK_COMPATIBILITY_PROBE_ENTITY = `0x${'11'.repeat(32)}`;

export const probeLocalAnvilContractStack = async (adapter: JAdapter): Promise<{ ok: boolean; reason: string }> => {
  const depositoryAddress = String(adapter.addresses?.depository || '').trim();
  if (!depositoryAddress) {
    return { ok: false, reason: 'DEPOSITORY_ADDRESS_MISSING' };
  }

  const code = await adapter.provider.getCode(depositoryAddress);
  if (!code || code === '0x') {
    return { ok: false, reason: 'DEPOSITORY_CODE_MISSING' };
  }

  const probe = new ethers.Contract(
    depositoryAddress,
    [
      'function getTokensLength() view returns(uint256)',
      'function mintToReserve(bytes32,uint256,uint256)',
    ],
    adapter.signer as ethers.ContractRunner,
  );
  const getTokensLength = probe.getFunction('getTokensLength') as unknown as () => Promise<bigint>;
  const mintToReserve = probe.getFunction('mintToReserve') as unknown as {
    estimateGas(entityId: string, tokenId: bigint, amount: bigint): Promise<bigint>;
  };

  let tokensLength = 0n;
  try {
    tokensLength = await getTokensLength();
  } catch (error) {
    return {
      ok: false,
      reason: `DEPOSITORY_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (tokensLength < 1n) {
    return { ok: false, reason: 'TOKEN_REGISTRY_EMPTY' };
  }

  try {
    await mintToReserve.estimateGas(STACK_COMPATIBILITY_PROBE_ENTITY, 1n, 1n);
  } catch (error) {
    return {
      ok: false,
      reason: `MINT_TO_RESERVE_UNAVAILABLE:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, reason: 'OK' };
};

export const fetchRpcCode = async (
  rpcUrl: string,
  address: string,
  timeoutMs = 10_000,
): Promise<string> => {
  if (!ethers.isAddress(address)) {
    throw new Error(`INVALID_PREDEPLOYED_ADDRESS:${String(address)}`);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ETH_GET_CODE_HTTP_${response.status}`);
    }

    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new Error(`ETH_GET_CODE_RPC:${body.error.message || 'unknown'}`);
    }
    if (typeof body.result !== 'string') {
      throw new Error('ETH_GET_CODE_INVALID_RESULT');
    }
    return body.result;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`ETH_GET_CODE_TIMEOUT:${address}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};
