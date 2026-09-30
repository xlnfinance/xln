// R-OOG fault isolation (reviewer B, RB-7, PR 64). Audit row "EntityProvider._requireReserveControlMajority ... By design (fault isolation: one broken Depository
// must not brick the lane)". Claim tested: a listed Depository that burns gas or returns a large payload cannot brick the lane.
import { expect } from 'chai';
import hre from 'hardhat';

import {
  boardHashOf, buildFoundationAction, buildSingleSignerHanko, computeDepositoryBatchHash, deployDepositoryStack, deployEntityProvider,
  deriveHardhatPrivateKey, emptyBatch, encodeBatch, encodeSingleSignerBoard, submitBatch,
} from '../helpers/hanko.ts';

const { ethers } = await hre.network.getOrCreate('hardhat');
const CONTROL = 1;
const TARGET_ID = ethers.zeroPadValue(ethers.toBeHex(2), 32);
const HOLDER_A_ID = ethers.zeroPadValue(ethers.toBeHex(3), 32);
const HOLDER_B_ID = ethers.zeroPadValue(ethers.toBeHex(4), 32);
const ARTICLES = { controlDelay: 3, dividendDelay: 5, foundationDelay: 7 };

async function fixture(badMode: number) {
  const signers = await ethers.getSigners();
  const provider = await deployEntityProvider(signers[0]!.address);
  const targetBoard = encodeSingleSignerBoard(signers[1]!.address);
  const argumentsHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)'], [boardHashOf(targetBoard), ARTICLES]));
  const registration = await buildFoundationAction(provider, await provider.FOUNDATION_REGISTER_ENTITY(), argumentsHash);
  await provider.foundationRegisterEntity(targetBoard, ARTICLES, registration.hankoData, registration.actionNonce);
  await provider.registerNumberedEntity(encodeSingleSignerBoard(signers[3]!.address));
  await provider.registerNumberedEntity(encodeSingleSignerBoard(signers[4]!.address));
  const { depository } = await deployDepositoryStack(await provider.getAddress());
  const supply = await provider.TOTAL_CONTROL_SUPPLY();
  const depositoryAddress = await depository.getAddress();

  // the list gets a second, misbehaving Depository (Foundation Hanko), and the target entity parks 1 unit of CONTROL there
  const bad = await (await ethers.getContractFactory('MisbehavingShareDepository')).deploy(await provider.getAddress(), badMode);
  const badAddress = await bad.getAddress();
  const add = await buildFoundationAction(provider, await provider.FOUNDATION_ADD_SHARE_DEPOSITORY(),
    ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address'], [badAddress])));
  await provider.foundationAddShareDepository(badAddress, add.hankoData, add.actionNonce);

  const release = async (to: string, amount: bigint, nonce: bigint) => {
    const h = await provider.computeReleaseControlSharesHankoHash(2n, to, amount, 0n, 'rb', nonce);
    await provider.releaseControlShares(2n, to, amount, 0n, 'rb', buildSingleSignerHanko(TARGET_ID, h, deriveHardhatPrivateKey(1)));
  };
  await release(depositoryAddress, supply - 1n, 1n);
  await release(badAddress, 1n, 2n);

  const controlTokenId = (await depository.getTokensLength()) - 1n;
  const held = supply - 1n;
  const amountA = (held * 60n) / 100n;
  const batch = emptyBatch({ reserveToReserve: [
    { receivingEntity: HOLDER_A_ID, tokenId: controlTokenId, amount: amountA },
    { receivingEntity: HOLDER_B_ID, tokenId: controlTokenId, amount: held - amountA },
  ] });
  const encodedBatch = encodeBatch(batch);
  const batchHash = await computeDepositoryBatchHash(depository, TARGET_ID, encodedBatch, 1n);
  await submitBatch(depository, signers[0]!, TARGET_ID, { encodedBatch, hankoData: buildSingleSignerHanko(TARGET_ID, batchHash, deriveHardhatPrivateKey(1)), nonce: 1n });
  return { provider };
}

const propose = async (fx: Awaited<ReturnType<typeof fixture>>, gasLimit: bigint): Promise<boolean> => {
  const member = ethers.getAddress(ethers.dataSlice(ethers.keccak256(ethers.toUtf8Bytes(`rb-${gasLimit}`)), 12));
  const encoded = encodeSingleSignerBoard(member);
  await (await fx.provider.commitBoard(encoded)).wait();
  const boardHash = boardHashOf(encoded);
  const digest = await fx.provider.computeBoardProposalHash(TARGET_ID, boardHash, CONTROL, 1n);
  const hanko = buildSingleSignerHanko(HOLDER_A_ID, digest, deriveHardhatPrivateKey(3));
  return fx.provider.proposeBoard.staticCall(TARGET_ID, boardHash, CONTROL, [hanko], { gasLimit }).then(() => true, () => false);
};

describe('R-OOG control lane: a listed Depository that misbehaves on the reads', function () {
  this.timeout(300_000);
  for (const [name, mode] of [['reverts', 0], ['burns all its gas', 2], ['returns as much as its gas pays for (return bomb)', 1]] as const) {
    it(`${name}: the lane still passes at every gas limit up to the block cap`, async function () {
      const fx = await fixture(mode);
      const results: Record<string, boolean> = {};
      for (const limit of [400_000n, 1_000_000n, 3_000_000n, 8_000_000n, 12_000_000n, 16_000_000n]) results[limit.toString()] = await propose(fx, limit);
      console.log(`      ${name}:`, JSON.stringify(results));
      // at df2801a (uncapped reads copied into `bytes memory`) the burner needs 8M+ gas and the bomb fails at every limit; with the capped one-word read all pass
      for (const [limit, ok] of Object.entries(results)) expect(ok, `the 60% proposal passes at ${limit}`).to.equal(true);
    });
  }
});
