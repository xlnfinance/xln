import { expect } from 'chai';
import hre from 'hardhat';

import {
  HANKO_ABI,
  addressEntityId,
  boardHashOf,
  buildClaimsHanko,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  encodeBoard,
} from '../helpers/hanko.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { loadFixture } = networkHelpers;
const abi = ethers.AbiCoder.defaultAbiCoder();

const CLAIMS_ABI = 'tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[]';
// The retired 3-field envelope: it must no longer decode on chain.
const LEGACY_HANKO_ABI = ['tuple(bytes32[],bytes,' + CLAIMS_ABI + ')'];
const ERC1271_MODE = { OWNER: 0, ALWAYS_VALID: 1, REVERT: 2 } as const;

type Claim = [entityId: string, entityIndexes: number[], weights: number[], threshold: number];

const packSignatures = (hash: string, privateKeys: string[]): string => {
  if (privateKeys.length === 0) return '0x';
  const signatures = privateKeys.map((key) => new ethers.SigningKey(key).sign(ethers.getBytes(hash)));
  const recoveryBits = new Uint8Array(Math.ceil(signatures.length / 8));
  signatures.forEach((signature, index) => {
    if (signature.v === 28) recoveryBits[Math.floor(index / 8)]! |= 1 << (index % 8);
  });
  return ethers.concat([...signatures.flatMap((s) => [s.r, s.s]), ethers.hexlify(recoveryBits)]);
};

const encodeClaims = (claims: Claim[]) =>
  claims.map(([entityId, entityIndexes, weights, threshold]) => [entityId, entityIndexes, weights, threshold, 0, 0, 0]);

/** abi.encode(HankoBytes{placeholders, packedSignatures, claims, memberSignatures}) — the one envelope. */
const buildMemberHanko = (
  hash: string,
  privateKeys: string[],
  placeholders: string[],
  claims: Claim[],
  memberSignatures: string[],
): string => abi.encode(
  HANKO_ABI,
  [[placeholders, packSignatures(hash, privateKeys), encodeClaims(claims), memberSignatures]],
);

const buildLegacyHanko = (hash: string, privateKeys: string[], placeholders: string[], claims: Claim[]): string =>
  abi.encode(LEGACY_HANKO_ABI, [[placeholders, packSignatures(hash, privateKeys), encodeClaims(claims)]]);

/** Plain 65-byte r||s||v(27/28) signature, what an ERC-1271 owner wallet would produce. */
const ecdsaSignature = (hash: string, privateKey: string): string =>
  new ethers.SigningKey(privateKey).sign(ethers.getBytes(hash)).serialized;

describe('HankoVerifier: ERC-1271 contract members (single 4-field envelope)', function () {
  const OWNER_INDEX = 5;
  const EOA_INDEX = 1;

  async function fixture() {
    const signers = await ethers.getSigners();
    const provider = await deployEntityProvider(signers[0]!.address);
    const mockFactory = await ethers.getContractFactory('ERC1271Mock');
    const wallet = await mockFactory.deploy(signers[OWNER_INDEX]!.address);
    await wallet.waitForDeployment();
    const walletAddress = await wallet.getAddress();
    const walletId = addressEntityId(walletAddress);
    const eoa = signers[EOA_INDEX]!;
    const eoaId = addressEntityId(eoa.address);
    const soloBoard = encodeBoard(1, [walletAddress], [1]);
    const soloId = boardHashOf(soloBoard);
    const mixedBoard = encodeBoard(2, [walletAddress, eoa.address], [1, 1]);
    const mixedId = boardHashOf(mixedBoard);
    const hash = ethers.keccak256(ethers.toUtf8Bytes('hanko-contract-member'));
    const ownerSig = ecdsaSignature(hash, deriveHardhatPrivateKey(OWNER_INDEX));
    return { provider, wallet, walletAddress, walletId, eoa, eoaId, soloBoard, soloId, mixedBoard, mixedId, hash, ownerSig };
  }

  it('lets one contract member reach threshold through memberSignatures', async function () {
    const { provider, walletId, soloId, mixedId, hash, ownerSig } = await loadFixture(fixture);
    const solo = buildMemberHanko(hash, [], [walletId], [[soloId, [0], [1], 1]], [ownerSig]);
    expect(await provider.verifyHankoSignature(solo, hash)).to.deep.equal([soloId, true]);
    expect(await provider.verifyCurrentHankoSignature(solo, hash)).to.deep.equal([soloId, true]);

    // 2-of-2: contract member (placeholder 0) + EOA signature (index 1).
    const mixed = buildMemberHanko(
      hash, [deriveHardhatPrivateKey(EOA_INDEX)], [walletId], [[mixedId, [0, 1], [1, 1], 2]], [ownerSig],
    );
    expect(await provider.verifyHankoSignature(mixed, hash)).to.deep.equal([mixedId, true]);
  });

  it('keeps the same member a zero-power placeholder when no member signature is supplied', async function () {
    const { provider, walletId, soloId, mixedId, hash } = await loadFixture(fixture);
    // memberSignatures = [] (no contract members at all).
    const soloEmpty = buildClaimsHanko(hash, [], [walletId], [[soloId, [0], [1], 1]]);
    expect(await provider.verifyHankoSignature(soloEmpty, hash)).to.deep.equal([ethers.ZeroHash, false]);

    // EOA signs, contract member is only a placeholder: 1 < threshold 2.
    const mixedEmpty = buildClaimsHanko(
      hash, [deriveHardhatPrivateKey(EOA_INDEX)], [walletId], [[mixedId, [0, 1], [1, 1], 2]],
    );
    expect(await provider.verifyHankoSignature(mixedEmpty, hash)).to.deep.equal([ethers.ZeroHash, false]);

    // Aligned but empty slot: same placeholder semantics.
    const mixedSlot = buildMemberHanko(
      hash, [deriveHardhatPrivateKey(EOA_INDEX)], [walletId], [[mixedId, [0, 1], [1, 1], 2]], ['0x'],
    );
    expect(await provider.verifyHankoSignature(mixedSlot, hash)).to.deep.equal([ethers.ZeroHash, false]);
  });

  it('fails softly for a reverting, rejecting, or code-less member', async function () {
    const { provider, wallet, walletId, eoaId, soloId, hash, ownerSig } = await loadFixture(fixture);
    const claim: Claim = [soloId, [0], [1], 1];

    await wallet.setMode(ERC1271_MODE.REVERT);
    expect(await provider.verifyHankoSignature(
      buildMemberHanko(hash, [], [walletId], [claim], [ownerSig]), hash,
    )).to.deep.equal([ethers.ZeroHash, false]);

    await wallet.setMode(ERC1271_MODE.OWNER);
    const strangerSig = ecdsaSignature(hash, deriveHardhatPrivateKey(7));
    expect(await provider.verifyHankoSignature(
      buildMemberHanko(hash, [], [walletId], [claim], [strangerSig]), hash,
    )).to.deep.equal([ethers.ZeroHash, false]);
    const otherHashSig = ecdsaSignature(ethers.keccak256('0x01'), deriveHardhatPrivateKey(OWNER_INDEX));
    expect(await provider.verifyHankoSignature(
      buildMemberHanko(hash, [], [walletId], [claim], [otherHashSig]), hash,
    )).to.deep.equal([ethers.ZeroHash, false]);

    // A member signature for an EOA placeholder (no code) cannot validate.
    const eoaBoardId = boardHashOf(encodeBoard(1, [ethers.dataSlice(eoaId, 12)], [1]));
    expect(await provider.verifyHankoSignature(
      buildMemberHanko(hash, [], [eoaId], [[eoaBoardId, [0], [1], 1]], [ownerSig]), hash,
    )).to.deep.equal([ethers.ZeroHash, false]);

    // Any bytes pass when the wallet itself accepts them; validity is wallet state.
    await wallet.setMode(ERC1271_MODE.ALWAYS_VALID);
    expect(await provider.verifyHankoSignature(
      buildMemberHanko(hash, [], [walletId], [claim], ['0x1234']), hash,
    )).to.deep.equal([soloId, true]);
  });

  it('accepts only the 4-field envelope: legacy, tagged, empty and misaligned encodings fail', async function () {
    const { provider, walletId, soloId, hash, ownerSig } = await loadFixture(fixture);
    const claim: Claim = [soloId, [0], [1], 1];
    const current = buildMemberHanko(hash, [], [walletId], [claim], [ownerSig]);
    expect(await provider.verifyHankoSignature(current, hash)).to.deep.equal([soloId, true]);

    // The retired 3-field struct is not decodable as HankoBytes any more.
    const legacy = buildLegacyHanko(hash, [], [walletId], [claim]);
    expect(ethers.dataLength(legacy)).to.not.equal(65);
    await expect(provider.verifyHankoSignature(legacy, hash)).to.be.revert(ethers);
    const legacySigned = buildLegacyHanko(hash, [deriveHardhatPrivateKey(EOA_INDEX)], [], [
      [boardHashOf(encodeBoard(1, [ethers.dataSlice(addressEntityId((await ethers.getSigners())[EOA_INDEX]!.address), 12)], [1])), [0], [1], 1],
    ]);
    await expect(provider.verifyHankoSignature(legacySigned, hash)).to.be.revert(ethers);
    // No version tags: a leading byte breaks the ABI head.
    await expect(provider.verifyHankoSignature(ethers.concat(['0x02', current]), hash)).to.be.revert(ethers);
    await expect(provider.verifyHankoSignature(ethers.concat(['0x01', current]), hash)).to.be.revert(ethers);
    await expect(provider.verifyHankoSignature('0x', hash)).to.be.revert(ethers);
    // memberSignatures must be empty or aligned with placeholders.
    await expect(provider.verifyHankoSignature(buildMemberHanko(hash, [], [walletId], [claim], [ownerSig, '0x']), hash))
      .to.be.revertedWithCustomError(provider, 'InvalidHankoMemberSignatures');
    await expect(provider.verifyHankoSignature(buildMemberHanko(hash, [], [], [claim], [ownerSig]), hash))
      .to.be.revertedWithCustomError(provider, 'InvalidHankoMemberSignatures');
  });

  it('still rejects a placeholder that equals a recovered signer', async function () {
    const { provider, eoaId, hash } = await loadFixture(fixture);
    const eoaBoardId = boardHashOf(encodeBoard(1, [ethers.dataSlice(eoaId, 12)], [1]));
    await expect(provider.verifyHankoSignature(
      buildMemberHanko(hash, [deriveHardhatPrivateKey(EOA_INDEX)], [eoaId], [[eoaBoardId, [1], [1], 1]], ['0x']),
      hash,
    )).to.be.revertedWithCustomError(provider, 'NonCanonicalHankoPlaceholder');
  });

  it('caps contract members per proof at 8', async function () {
    const { provider, hash } = await loadFixture(fixture);
    const mockFactory = await ethers.getContractFactory('ERC1271Mock');
    const members: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const wallet = await mockFactory.deploy(ethers.ZeroAddress);
      await wallet.waitForDeployment();
      await wallet.setMode(ERC1271_MODE.ALWAYS_VALID);
      members.push(await wallet.getAddress());
    }
    const ids = members.map(addressEntityId);
    const indexes = members.map((_, i) => i);
    const weights = members.map(() => 1);
    const eightId = boardHashOf(encodeBoard(1, members.slice(0, 8), weights.slice(0, 8)));
    expect(await provider.verifyHankoSignature(
      buildMemberHanko(hash, [], ids.slice(0, 8), [[eightId, indexes.slice(0, 8), weights.slice(0, 8), 1]], Array(8).fill('0x01')),
      hash,
    )).to.deep.equal([eightId, true]);
    const nineId = boardHashOf(encodeBoard(1, members, weights));
    await expect(provider.verifyHankoSignature(
      buildMemberHanko(hash, [], ids, [[nineId, indexes, weights, 1]], Array(9).fill('0x01')),
      hash,
    )).to.be.revertedWithCustomError(provider, 'HankoProofTooLarge');
  });

  it('authorizes a registered entity action with a contract-member board', async function () {
    const { provider, walletId, mixedBoard, eoa } = await loadFixture(fixture);
    await (await provider.registerNumberedEntity(mixedBoard)).wait();
    const entityNumber = 2n;
    const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
    const [controlTokenId] = await provider.getTokenIds(entityNumber);
    const transferHash = await provider.computeEntityTransferHankoHash(entityNumber, eoa.address, controlTokenId, 5n, 1n);
    const hanko = buildMemberHanko(
      transferHash,
      [deriveHardhatPrivateKey(EOA_INDEX)],
      [walletId],
      [[entityId, [0, 1], [1, 1], 2]],
      [ecdsaSignature(transferHash, deriveHardhatPrivateKey(OWNER_INDEX))],
    );
    await expect(provider.entityTransferTokens(entityNumber, eoa.address, controlTokenId, 5n, hanko))
      .to.emit(provider, 'EntityProviderActionExecuted');
    expect(await provider.balanceOf(eoa.address, controlTokenId)).to.equal(5n);
  });
});
