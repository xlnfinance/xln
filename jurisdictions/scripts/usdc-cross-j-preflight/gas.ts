import { Interface, toQuantity } from 'ethers';
import type { PreflightProvider } from './provider';
import type { PreparedIdentities, networks } from './identities';

const erc20 = new Interface([
  'function transfer(address,uint256) returns(bool)',
  'function approve(address,uint256) returns(bool)',
]);
const nodeInterface = new Interface([
  'function gasEstimateComponents(address,bool,bytes) payable returns(uint64 gasEstimate,uint64 gasEstimateForL1,uint256 baseFee,uint256 l1BaseFeeEstimate)',
]);

const estimateCall = async (
  provider: PreflightProvider,
  chainId: number,
  point: number,
  call: { from: string; to: string; data: string },
) => {
  try {
    const rawGas = await provider.send('eth_estimateGas', [call, toQuantity(point)]);
    if (typeof rawGas !== 'string' || !/^0x[0-9a-f]+$/i.test(rawGas)) throw new Error('USDC_PREFLIGHT_GAS_INVALID');
    const gas = BigInt(rawGas);
    if (chainId !== 421614) return { status: 'estimated', gas };
    const result = await provider.send('eth_call', [
      {
        from: call.from,
        to: '0x00000000000000000000000000000000000000C8',
        data: nodeInterface.encodeFunctionData('gasEstimateComponents', [call.to, false, call.data]),
      },
      toQuantity(point),
    ]);
    if (typeof result !== 'string') throw new Error('USDC_PREFLIGHT_NITRO_RESULT_INVALID');
    const [totalGas, l1Gas, baseFee, l1BaseFeeEstimate] = nodeInterface.decodeFunctionResult(
      'gasEstimateComponents',
      result,
    );
    return {
      status: 'estimated',
      gas,
      nitro: {
        totalGas: String(totalGas),
        l1Gas: String(l1Gas),
        baseFeeWei: String(baseFee),
        l1BaseFeeEstimateWei: String(l1BaseFeeEstimate),
        l1IncludedInTotal: true,
      },
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'RPC_ERROR';
    return { status: 'blocked', reason: code };
  }
};

export const estimatePreparation = async (
  provider: PreflightProvider,
  chain: (typeof networks)[number],
  point: number,
  funder: string,
  depository: string,
  identities: PreparedIdentities,
) => {
  const account = identities
    .find(identity => identity.role === 'user')
    ?.chains.find(value => value.chainId === chain.chainId);
  if (!account) throw new Error('USDC_PREFLIGHT_GAS_IDENTITY_MISSING');
  const amount = 1_000_000n;
  const operatorApproval = {
    stage: 'operator-hub-reserve-approval',
    payer: funder,
    amount,
    call: { from: funder, to: chain.token, data: erc20.encodeFunctionData('approve', [depository, amount]) },
  };
  const calls =
    chain.chainId === 421614
      ? [operatorApproval]
      : [
          operatorApproval,
          {
            stage: 'user-source-token-funding',
            payer: funder,
            amount,
            call: {
              from: funder,
              to: chain.token,
              data: erc20.encodeFunctionData('transfer', [account.signerId, amount]),
            },
          },
          {
            stage: 'user-source-approval',
            payer: account.signerId,
            amount,
            call: {
              from: account.signerId,
              to: chain.token,
              data: erc20.encodeFunctionData('approve', [depository, amount]),
            },
          },
        ];
  return Promise.all(
    calls.map(async request => ({
      ...request,
      estimate: await estimateCall(provider, chain.chainId, point, request.call),
    })),
  );
};
