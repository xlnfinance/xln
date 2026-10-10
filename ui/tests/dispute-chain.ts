import { JsonRpcProvider } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { IERC20__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/IERC20__factory';
import { computeAccountKey } from '../../core/jurisdiction/adapter/events/contract-codec';
import { decodeInt512 } from '../../core/protocol/crypto/abi-money';
import { LOCAL_TEST_STACK_BASES } from '../../core/scripts/e2e/harness/local-test-port-lease';

export function privateChain(baseURL: string | undefined): JsonRpcProvider {
  const rpc = process.env['XLN_UI_DISPUTE_PRIVATE_RPC'];
  const origin = process.env['XLN_UI_DISPUTE_PRIVATE_ORIGIN'];
  if (!rpc || !origin || baseURL !== origin) throw new Error('DISPUTE_ISOLATED_STAND_REQUIRED');
  const url = new URL(rpc);
  const base = Number(url.port);
  if (
    url.hostname !== '127.0.0.1' ||
    !LOCAL_TEST_STACK_BASES.some(port => port === base) ||
    origin !== `http://127.0.0.1:${base + 2}`
  )
    throw new Error('DISPUTE_PRIVATE_CLOCK_ENDPOINT_INVALID');
  return new JsonRpcProvider(rpc, 31337, { staticNetwork: true, cacheTimeout: -1 });
}

type Depository = ReturnType<typeof Depository__factory.connect>;
export async function externalUsdc(contract: Depository, owner: string, provider: JsonRpcProvider): Promise<bigint> {
  const token = await contract._tokens(1);
  if (token.tokenType !== 0n) throw new Error('DISPUTE_USDC_MUST_BE_ERC20');
  return IERC20__factory.connect(token.contractAddress, provider).balanceOf(owner);
}

export async function chainMoney(contract: Depository, owner: string, hub: string) {
  const key = computeAccountKey(owner, hub);
  const [reserve, peerReserve, collateral, account] = await Promise.all([
    contract._reserves(owner, 1),
    contract._reserves(hub, 1),
    contract._collaterals(key, 1),
    contract._accounts(key),
  ]);
  return {
    reserve: reserve.toString(),
    peerReserve: peerReserve.toString(),
    collateral: collateral.collateral.toString(),
    ondelta: decodeInt512(collateral.ondelta).toString(),
    nonce: account.nonce.toString(),
    disputeHash: account.disputeHash,
    timeout: Number(account.disputeTimeout),
  };
}
