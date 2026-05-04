import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import type { Depository, EntityProvider } from "../typechain-types/index.js";
import {
  addressEntityId,
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from "./helpers/hanko.ts";

/**
 * Hanko Authorization Tests
 */
describe("Hanko Authorization", function () {
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

    const entity1Id = singleSignerLazyEntityId(entity1.address);
    const entity2Id = addressEntityId(entity2.address);
    const tokenId = 1;
    const fundAmount = 1_000n;
    const transferAmount = 100n;

    await depository.mintToReserve(entity1Id, tokenId, fundAmount);

    const batch = emptyBatch({
      reserveToReserve: [{ receivingEntity: entity2Id, tokenId, amount: transferAmount }],
    });

    const encodedBatch = encodeBatch(batch);
    const entityNonce = await depository.entityNonces(entity1Id);
    const nextNonce = entityNonce + 1n;
    const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, nextNonce);
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
