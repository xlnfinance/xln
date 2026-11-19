/** Private Anvil approval values only; these are not proposed public caps. */
export const privateFundingLimits = () => ({
  expiresAt: Date.now() + 600_000,
  chains: [11155111, 421614].map(chainId => ({
    chainId,
    amount: chainId === 11155111 ? '1000000' : '5000000',
    hubTopupWei: chainId === 11155111 ? '1000000000000000' : '100000000000000',
    totalFeeLimitWei: '10000000000000000',
    totalNativeOutflowLimitWei: chainId === 11155111 ? '11000000000000000' : '10100000000000000',
    calls: {
      approval: { gasLimit: '200000', maxFeePerGasWei: '5000000000', maxPriorityFeePerGasWei: '1000000000' },
      deposit: { gasLimit: '600000', maxFeePerGasWei: '5000000000', maxPriorityFeePerGasWei: '1000000000' },
      'native-topup': { gasLimit: '300000', maxFeePerGasWei: '5000000000', maxPriorityFeePerGasWei: '1000000000' },
    },
  })),
});

export const privateDemoFundingLimits = (userSigners: readonly string[]) => {
  const limits = privateFundingLimits();
  return {
    ...limits,
    chains: limits.chains.map((chain, index) => ({
      ...chain,
      amount: index === 0 ? '1' : '1000000',
      totalNativeOutflowLimitWei: index === 0 ? '13000000000000000' : '10200000000000000',
      userFunding: {
        signer: userSigners[index]!,
        usdcAtoms: index === 0 ? '1000000' : '0',
        nativeTopupWei: index === 0 ? '2000000000000000' : '100000000000000',
        principalTransfer: index === 0 ? chain.calls.approval : null,
        nativeTopup: chain.calls['native-topup'],
      },
    })),
  };
};
