import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import type { Depository, EntityProvider } from "../typechain-types/index.js";

/**
 * Hanko Authorization Tests
 */
describe("Hanko Authorization", function () {
  const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";
  const BATCH_ABI = [
    'tuple(' +
      'tuple(uint256 tokenId, uint256 amount)[] flashloans,' +
      'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToReserve,' +
      'tuple(uint256 tokenId, bytes32 receivingEntity, tuple(bytes32 entity, uint256 amount)[] pairs)[] reserveToCollateral,' +
      'tuple(bytes32 counterparty, uint256 tokenId, uint256 amount, uint256 nonce, bytes sig)[] collateralToReserve,' +
      'tuple(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig, address entityProvider, bytes hankoData, uint256 nonce)[] settlements,' +
      'tuple(bytes32 counterentity, uint256 nonce, bytes32 proofbodyHash, bytes sig, bytes initialArguments)[] disputeStarts,' +
      'tuple(bytes32 counterentity, uint256 initialNonce, uint256 finalNonce, bytes32 initialProofbodyHash, tuple(int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) finalProofbody, bytes finalArguments, bytes initialArguments, bytes sig, bool startedByLeft, uint256 disputeUntilBlock, bool cooperative)[] disputeFinalizations,' +
      'tuple(bytes32 entity, address contractAddress, uint96 externalTokenId, uint8 tokenType, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve,' +
      'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToExternalToken,' +
      'tuple(address transformer, bytes32 secret)[] revealSecrets,' +
      'uint256 hub_id' +
    ')'
  ];
  const HANKO_ABI = ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'];
  const BATCH_DOMAIN_SEPARATOR = ethers.keccak256(ethers.toUtf8Bytes("XLN_DEPOSITORY_HANKO_V1"));
  let depository: Depository;
  let entityProvider: EntityProvider;
  let admin: HardhatEthersSigner;
  let entity1: HardhatEthersSigner;
  let entity2: HardhatEthersSigner;

  async function deployFixture() {
    [admin, entity1, entity2] = await hre.ethers.getSigners();

    // Deploy EntityProvider
    const EntityProviderFactory = await hre.ethers.getContractFactory("EntityProvider");
    entityProvider = await EntityProviderFactory.deploy();
    await entityProvider.waitForDeployment();

    // Deploy Account library first
    const AccountFactory = await hre.ethers.getContractFactory("Account");
    const account = await AccountFactory.deploy();
    await account.waitForDeployment();

    // Deploy Depository with Account library linked
    const DepositoryFactory = await hre.ethers.getContractFactory("Depository", {
      libraries: {
        Account: await account.getAddress()
      }
    });
    depository = await DepositoryFactory.deploy(await entityProvider.getAddress());
    await depository.waitForDeployment();

    return { depository, entityProvider, admin, entity1, entity2 };
  }

  const deriveHardhatPrivateKey = (index: number): string =>
    ethers.HDNodeWallet.fromPhrase(DEFAULT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).privateKey;
  const encodeBatch = (batch: unknown): string =>
    ethers.AbiCoder.defaultAbiCoder().encode(BATCH_ABI, [batch]);
  const buildSingleSignerHanko = (entityId: string, hash: string, privateKey: string): string => {
    const signingKey = new ethers.SigningKey(privateKey);
    const signature = signingKey.sign(ethers.getBytes(hash));
    const vBit = signature.v === 28 ? 1 : 0;
    const packedSig = ethers.concat([signature.r, signature.s, ethers.toBeHex(vBit, 1)]);
    const paddedEntityId = ethers.zeroPadValue(entityId, 32);
    return ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
      [],
      packedSig,
      [[paddedEntityId, [0], [1], 1]],
    ]]);
  };

  it("processBatch rejects invalid Hanko", async function () {
    const { depository, entityProvider } = await loadFixture(deployFixture);

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const emptyHanko = coder.encode(
      [
        "tuple(bytes32[] placeholders, bytes packedSignatures, tuple(bytes32 entityId, uint256[] entityIndexes, uint256[] weights, uint256 threshold)[] claims)"
      ],
      [
        {
          placeholders: [],
          packedSignatures: "0x",
          claims: []
        }
      ]
    );

    await expect(
      depository.processBatch("0x", emptyHanko, 1)
    ).to.be.revertedWithCustomError(depository, "E4");
  });

  it("processBatch accepts a correctly signed single-signer reserve transfer", async function () {
    const { depository, entityProvider, entity1, entity2 } = await loadFixture(deployFixture);

    const entity1Id = ethers.zeroPadValue(entity1.address, 32);
    const entity2Id = ethers.zeroPadValue(entity2.address, 32);
    const tokenId = 1;
    const fundAmount = 1_000n;
    const transferAmount = 100n;

    await depository.mintToReserve(entity1Id, tokenId, fundAmount);

    const batch = {
      flashloans: [],
      reserveToReserve: [{ receivingEntity: entity2Id, tokenId, amount: transferAmount }],
      reserveToCollateral: [],
      collateralToReserve: [],
      settlements: [],
      disputeStarts: [],
      disputeFinalizations: [],
      externalTokenToReserve: [],
      reserveToExternalToken: [],
      revealSecrets: [],
      hub_id: 0,
    };

    const encodedBatch = encodeBatch(batch);
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
    const entityNonce = await depository.entityNonces(entity1Id);
    const nextNonce = entityNonce + 1n;
    const batchHash = ethers.keccak256(ethers.solidityPacked(
      ['bytes32', 'uint256', 'address', 'bytes', 'uint256'],
      [BATCH_DOMAIN_SEPARATOR, chainId, await depository.getAddress(), encodedBatch, nextNonce]
    ));
    const hankoData = buildSingleSignerHanko(entity1Id, batchHash, deriveHardhatPrivateKey(1));

    await expect(
      depository
        .connect(entity1)
        .processBatch(encodedBatch, hankoData, nextNonce)
    ).to.not.be.reverted;

    const entity1Balance = await depository._reserves(entity1Id, tokenId);
    const entity2Balance = await depository._reserves(entity2Id, tokenId);
    expect(entity1Balance).to.equal(fundAmount - transferAmount);
    expect(entity2Balance).to.equal(transferAmount);
  });

  it("does not expose unsafeProcessBatch", async function () {
    const { depository } = await loadFixture(deployFixture);
    expect(depository.interface.hasFunction("unsafeProcessBatch")).to.equal(false);
  });
});
