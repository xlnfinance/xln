import { isLoopbackUrl } from '../../../../core/network/p2p/loopback-url';
import { sanitizeDeploymentMessage } from '../../deployment/evidence.cjs';
import { preflightProvider } from '../provider';

const arbitrumSepolia = 421614;
type HeaderCall = Readonly<{ method: string; params: readonly unknown[] }>;

/** Share history below the common block verified at gateway startup. A batch
 * containing a newer tip must stay with the RPC that reported its height:
 * the other RPC can return null for that height even on the same chain. */
export const createArbitrumHeaderRouter = (verifiedCommonHeight: number) => {
  const historyEndExclusive = BigInt(verifiedCommonHeight);
  let useSecondary = false;
  return (chainId: number, calls: readonly HeaderCall[]): boolean => {
    if (
      chainId !== arbitrumSepolia ||
      !calls.length ||
      !calls.every(({ method, params }) =>
        method === 'eth_getBlockByNumber' && params.length === 2 && params[1] === false &&
        typeof params[0] === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(params[0]) &&
        BigInt(params[0]) < historyEndExclusive,
      )
    ) return false;
    useSecondary = !useSecondary;
    return useSecondary;
  };
};

export const parseSecondaryHeaderRpc = (primary: string, secondary: string): string => {
  const url = URL.canParse(secondary) ? new URL(secondary) : null;
  if (!url || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackUrl(url.href))))
    throw new Error('USDC_PREFLIGHT_ARBITRUM_HEADER_RPC_INVALID');
  if (url.href === new URL(primary).href) throw new Error('USDC_PREFLIGHT_ARBITRUM_HEADER_RPC_DUPLICATE');
  return url.href;
};

export const verifySecondaryHeaderRpc = async (primary: string, secondary: string): Promise<number> => {
  const readers = [primary, secondary].map(rpc => preflightProvider(rpc, arbitrumSepolia, true));
  try {
    const ids = await Promise.all(readers.map(reader => reader.send('eth_chainId', [])));
    if (ids.some(id => Number(id) !== arbitrumSepolia))
      throw new Error('USDC_PREFLIGHT_ARBITRUM_HEADER_RPC_CHAIN_MISMATCH');
    const height = Math.min(...await Promise.all(readers.map(reader => reader.getBlockNumber())));
    const [left, right] = await Promise.all(readers.map(reader => reader.getBlock(height)));
    if (!left?.hash || left.number !== height || right?.number !== height || left.hash !== right.hash)
      throw new Error('USDC_PREFLIGHT_ARBITRUM_HEADER_RPC_BLOCK_MISMATCH');
    return height;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const masked = sanitizeDeploymentMessage(sanitizeDeploymentMessage(detail, '', primary), '', secondary);
    throw new Error(`USDC_PREFLIGHT_ARBITRUM_HEADER_RPC_CHECK_FAILED:${masked}`);
  } finally {
    for (const reader of readers) reader.destroy();
  }
};
