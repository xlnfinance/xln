import { expect } from 'chai';
import hre from 'hardhat';
import {
  addressEntityId,
  buildClaimsHanko,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  encodeBoard,
  entityTreasuryAddress,
} from '../../helpers/hanko.ts';

const { ethers } = await hre.network.getOrCreate('hardhat');
const COMPANY_GAS_LIMIT = 6_000_000n;

describe('EP multisig company with onchain shares', function () {
  it('creates a 2-of-3 company and distributes shares only with its quorum, within the XLNC transaction budget', async function () {
    const [founder, first, second, third, investor, relayer] = await ethers.getSigners();
    const provider = await deployEntityProvider(founder.address);
    const members = [first, second, third].map(signer => addressEntityId(signer.address));
    const board = encodeBoard(2, members, [1, 1, 1]);
    const registration = await (
      await provider.connect(relayer).registerNumberedEntity(board, { gasLimit: COMPANY_GAS_LIMIT })
    ).wait();
    if (!registration) throw new Error('COMPANY_REGISTRATION_RECEIPT_MISSING');

    const company = 2n;
    const entityId = ethers.zeroPadValue(ethers.toBeHex(company), 32);
    const treasury = entityTreasuryAddress(company);
    const [control, dividend] = await provider.getTokenIds(company);
    const controlSupply = await provider.TOTAL_CONTROL_SUPPLY();
    const dividendSupply = await provider.TOTAL_DIVIDEND_SUPPLY();
    expect((await provider.entities(entityId)).currentBoardHash).to.equal(ethers.keccak256(board));
    expect(await provider.balanceOf(treasury, control)).to.equal(controlSupply);
    expect(await provider.balanceOf(treasury, dividend)).to.equal(dividendSupply);
    expect(await provider.balanceOf(relayer.address, dividend)).to.equal(0n);
    expect(registration.gasUsed).to.be.lessThanOrEqual(COMPANY_GAS_LIMIT);

    const amount = 1_000n;
    const hash = await provider.computeEntityTransferHankoHash(company, investor.address, dividend, amount, 1n);
    // Slots are placeholders followed by recovered signers. Both envelopes
    // reconstruct the exact registered board; only the second reaches 2-of-3.
    // The submitter is a relayer, never an owner. Nonce 1 binds this allocation;
    // a single director, changed recipient and replay must not move any shares.
    const oneSignature = buildClaimsHanko(
      hash,
      [deriveHardhatPrivateKey(1)],
      [members[1], members[2]],
      [[entityId, [2, 0, 1], [1, 1, 1], 2]],
    );
    await expect(
      provider
        .connect(relayer)
        .entityTransferTokens(company, investor.address, dividend, amount, oneSignature, {
          gasLimit: COMPANY_GAS_LIMIT,
        }),
    ).to.be.revertedWith('Invalid entity signature');
    expect(await provider.entityActionNonces(entityId)).to.equal(0n);
    expect(await provider.balanceOf(treasury, dividend)).to.equal(dividendSupply);

    const quorum = buildClaimsHanko(
      hash,
      [deriveHardhatPrivateKey(1), deriveHardhatPrivateKey(2)],
      [members[2]],
      [[entityId, [1, 2, 0], [1, 1, 1], 2]],
    );
    await expect(
      provider
        .connect(relayer)
        .entityTransferTokens(company, relayer.address, dividend, amount, quorum, { gasLimit: COMPANY_GAS_LIMIT }),
    ).to.be.revertedWith('Invalid entity signature');
    expect(await provider.entityActionNonces(entityId)).to.equal(0n);

    const allocation = await (
      await provider
        .connect(relayer)
        .entityTransferTokens(company, investor.address, dividend, amount, quorum, { gasLimit: COMPANY_GAS_LIMIT })
    ).wait();
    if (!allocation) throw new Error('COMPANY_ALLOCATION_RECEIPT_MISSING');
    expect(allocation.gasUsed).to.be.lessThanOrEqual(COMPANY_GAS_LIMIT);
    expect(await provider.balanceOf(investor.address, dividend)).to.equal(amount);
    expect(await provider.balanceOf(treasury, dividend)).to.equal(dividendSupply - amount);
    expect(await provider.balanceOf(treasury, control)).to.equal(controlSupply);
    expect(await provider.entityActionNonces(entityId)).to.equal(1n);

    await expect(
      provider
        .connect(relayer)
        .entityTransferTokens(company, investor.address, dividend, amount, quorum, { gasLimit: COMPANY_GAS_LIMIT }),
    ).to.be.revertedWith('Invalid entity signature');
    expect(await provider.entityActionNonces(entityId)).to.equal(1n);
    expect(await provider.balanceOf(investor.address, dividend)).to.equal(amount);
    expect(await provider.balanceOf(treasury, dividend)).to.equal(dividendSupply - amount);
    console.log(
      `XLNC_COMPANY_GAS registration=${registration.gasUsed} allocation=${allocation.gasUsed} limit=${COMPANY_GAS_LIMIT}`,
    );
  });
});
