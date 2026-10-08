import { getCreate2Address, keccak256, resolveAddress, ZeroHash } from 'ethers';
import type { Signer } from 'ethers';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { JBatch } from '../../../machine/batch';
import type { RpcContractStack } from '../rpc-contract-stack';
import type { RpcTransactionSequencer } from './rpc-transaction-sequencer';

/** Called only by the post-WAL J submitter. The signed finalization chooses
 * addresses; committed Account state supplies their crash-recoverable initcode.
 * CREATE2 plus checking chain code makes retries independent of a local receipt. */
export const materializeCustomContracts = async (input: {
  env: RuntimeReplica; entityId: string; batch: JBatch; stack: RpcContractStack;
  signer: Signer; sequencer: RpcTransactionSequencer;
}): Promise<void> => {
  if (input.batch.disputeFinalizations.length === 0) return;
  const replica = [...input.env.state.eReplicas.values()].find(r => r.state.entityId === input.entityId);
  if (!replica) throw new Error(`CUSTOM_CONTRACT_ENTITY_MISSING:${input.entityId}`);
  const factory = input.stack.deltaTransformer.connect(input.signer);
  const factoryAddress = await factory.getAddress();
  const provider = input.signer.provider;
  if (!provider) throw new Error('CUSTOM_CONTRACT_PROVIDER_MISSING');
  for (const finalization of input.batch.disputeFinalizations) {
    const account = replica.state.accounts.get(finalization.counterentity);
    if (!account) throw new Error(`CUSTOM_CONTRACT_ACCOUNT_MISSING:${finalization.counterentity}`);
    for (const clause of finalization.finalProofbody.transformers) {
      const signedAddress = (await resolveAddress(clause.transformerAddress)).toLowerCase();
      const program = [...(account.state.subcontracts?.values() ?? [])]
        .find(entry => entry.status === 'active' && entry.transformerAddress.toLowerCase() === signedAddress);
      if (!program) continue; // Stock / explicitly deployed transformers need no materialization.
      const address = getCreate2Address(factoryAddress, ZeroHash, keccak256(program.initcode));
      if (address.toLowerCase() !== program.transformerAddress) throw new Error('CUSTOM_CONTRACT_FACTORY_DOMAIN_MISMATCH');
      if (await provider.getCode(address) !== '0x') continue;
      const gas = await factory.deployCustomTransformer.estimateGas(program.initcode);
      const head = await provider.getBlock('latest');
      if (!head || gas + gas / 5n > head.gasLimit) throw new Error(`CUSTOM_CONTRACT_DEPLOY_GAS_EXCEEDS_BLOCK:${gas}:${head?.gasLimit}`);
      await input.sequencer.send(input.signer, 'custom-transformer:deploy', (nonce, fees) =>
        factory.deployCustomTransformer(program.initcode, { nonce, gasLimit: gas + gas / 5n, ...fees }));
      if (await provider.getCode(address) === '0x') throw new Error('CUSTOM_CONTRACT_DEPLOY_CODE_MISSING');
    }
  }
};
