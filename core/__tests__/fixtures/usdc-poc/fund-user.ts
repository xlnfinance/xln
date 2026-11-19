import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProvider, NonceManager, Wallet } from 'ethers';
import { ERC20Mock__factory } from '../../../../jurisdictions/typechain-types';
import { bootUser, openPocAccount, userReplica, send, waitFor, closeUser } from '../../../scenarios/usdc-poc/user';
import { runtimeProof } from '../../../scenarios/usdc-poc/recovery/evidence';
import { deriveRuntimeSignerPrivateKey } from '../../../storage/recovery/bundle/seed-identity';
import { readExistingIdentities } from '../../../../jurisdictions/scripts/usdc-cross-j-preflight/identities';
import { safeStringify } from '../../../protocol/serialization';
import { isLoopbackUrl } from '../../../network/p2p/loopback-url';

const [root, apiBase] = process.argv.slice(2);
if (!root || !apiBase || !isLoopbackUrl(apiBase)) throw new Error('USDC_FIXTURE_LOCAL_INPUT_REQUIRED');
const user = await bootUser(apiBase, join(root, 'user'));
const identities = readExistingIdentities(root);
const provider = new JsonRpcProvider(`${apiBase}/rpc`);
try {
  // This read establishes an actual private Anvil before the public fixture key signs.
  await provider.send('anvil_nodeInfo', []);
  for (const jurisdiction of user.jurisdictions) {
    const own = user.identities.find(chain => chain.chainId === jurisdiction.chainId)!;
    const hub = identities
      .find(identity => identity.role === 'hub')!
      .chains.find(chain => chain.chainId === jurisdiction.chainId)!;
    await openPocAccount({ ...user, ...own, jurisdiction }, apiBase, hub.entityId);
  }
  if (!process.argv.includes('--accounts-only')) {
    const genesis = new NonceManager(
      Wallet.fromPhrase('test test test test test test test test test test test junk', provider),
    );
    const { Depository__factory } = await import('../../../../jurisdictions/typechain-types');
    const depository = Depository__factory.connect(user.jurisdiction.contracts.depository, provider);
    const token = ERC20Mock__factory.connect((await depository._tokens(1)).contractAddress, genesis);
    const wallet = new Wallet(deriveRuntimeSignerPrivateKey(user.seed, 0), provider);
    await (await genesis.sendTransaction({ to: wallet.address, value: 10n ** 17n })).wait();
    await (await token.transfer(wallet.address, 1_000_000n)).wait();
    await (await token.connect(wallet).approve(await depository.getAddress(), 1_000_000n)).wait();
    send(user, [
      { type: 'e2r', data: { contractAddress: await token.getAddress(), internalTokenId: 1, amount: 1_000_000n } },
      { type: 'j_broadcast', data: {} },
    ]);
    await waitFor('funded-user-reserve', () => userReplica(user).state.reserves.get(1) === 1_000_000n);
    const hub = identities.find(identity => identity.role === 'hub')!.chains[0]!.entityId;
    send(user, [
      { type: 'r2c', data: { counterpartyId: hub, tokenId: 1, amount: 1_000_000n } },
      { type: 'j_broadcast', data: {} },
    ]);
    await waitFor('funded-user-account', () => {
      const account = userReplica(user).state.accounts.get(hub);
      return Boolean(
        account &&
        account.state.deltas.get(1)?.collateral === 1_000_000n &&
        !account.pendingFrame &&
        account.mempool.length === 0,
      );
    });
  }
} finally {
  await closeUser(user);
  provider.destroy();
}
writeFileSync(join(root, 'funded-user.json'), safeStringify(runtimeProof(user), 2), { mode: 0o600 });
