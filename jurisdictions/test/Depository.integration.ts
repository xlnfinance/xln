import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import hre from "hardhat";
const { ethers } = hre;

const coder = ethers.AbiCoder.defaultAbiCoder();

function addressToEntity(addr: string): string {
  return ethers.zeroPadValue(addr, 32);
}

function entityToAddress(entity: string): string {
  return ethers.getAddress(ethers.dataSlice(entity, 12));
}

async function deployDepositoryFixture() {
  const [admin, user1, user2] = await ethers.getSigners();

  const Depository = await ethers.getContractFactory("Depository");
  const depository = await Depository.deploy();
  await depository.waitForDeployment();

  const MockEntityProvider = await ethers.getContractFactory("MockEntityProvider");
  const entityId = addressToEntity(admin.address);
  const mockProvider = await MockEntityProvider.deploy(entityId);
  await mockProvider.waitForDeployment();

  return { depository, mockProvider, admin, user1, user2, entityId };
}

describe("Depository integration", function () {
  describe("processBatchWithHanko", function () {
    it("processes a reserve transfer using mock Hanko approval", async function () {
      const { depository, mockProvider, admin, user1, entityId } = await loadFixture(deployDepositoryFixture);

      const tokenId = 1;
      const amount = 200n;

      const senderEntity = entityId;
      const receiverEntity = addressToEntity(user1.address);

      await depository.addEntityProvider(await mockProvider.getAddress());
      await depository.debugFundReserves(senderEntity, tokenId, 1_000n);

      const BatchType =
        "tuple(" +
        "tuple(bytes32 receivingEntity,uint256 tokenId,uint256 amount)[]," + // reserveToExternalToken
        "tuple(bytes32 entity,bytes32 packedToken,uint256 internalTokenId,uint256 amount)[]," + // externalTokenToReserve
        "tuple(bytes32 receivingEntity,uint256 tokenId,uint256 amount)[]," + // reserveToReserve
        "tuple(uint256 tokenId,bytes32 receivingEntity,tuple(bytes32 entity,uint256 amount)[] pairs)[]," + // reserveToCollateral
        "tuple(bytes32 leftEntity,bytes32 rightEntity,tuple(uint256 tokenId,int256 leftDiff,int256 rightDiff,int256 collateralDiff,int256 ondeltaDiff)[] diffs,uint256[] forgiveDebtsInTokenIds,bytes sig)[]," + // settlements
        "tuple(bytes32 counterentity,tuple(uint256 tokenId,int256 peerReserveDiff,int256 collateralDiff,int256 ondeltaDiff)[] diffs,uint256[] forgiveDebtsInTokenIds,bytes sig)[]," + // cooperativeUpdate
        "tuple(bytes32 counterentity,tuple(int256[] offdeltas,uint256[] tokenIds,tuple(address subcontractProviderAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowence,uint256 leftAllowence)[])[] subcontracts) proofbody,bytes initialArguments,bytes finalArguments,bytes sig)[]," + // cooperativeDisputeProof
        "tuple(bytes32 counterentity,uint256 cooperativeNonce,uint256 disputeNonce,bytes32 proofbodyHash,bytes sig,bytes initialArguments)[]," + // initialDisputeProof
        "tuple(bytes32 counterentity,uint256 initialCooperativeNonce,uint256 initialDisputeNonce,uint256 disputeUntilBlock,bytes32 initialProofbodyHash,bytes initialArguments,bool startedByLeft,uint256 finalCooperativeNonce,uint256 finalDisputeNonce,tuple(int256[] offdeltas,uint256[] tokenIds,tuple(address subcontractProviderAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowence,uint256 leftAllowence)[])[] subcontracts) finalProofbody,bytes finalArguments,bytes sig)[]," + // finalDisputeProof
        "tuple(uint256 tokenId,uint256 amount)[]," + // flashloans
        "uint256" + // hub_id
        ")";

      const encodedBatch = coder.encode(
        [BatchType],
        [[
          [], // reserveToExternalToken
          [], // externalTokenToReserve
          [{ receivingEntity: receiverEntity, tokenId, amount }], // reserveToReserve
          [], // reserveToCollateral
          [], // settlements
          [], // cooperativeUpdate
          [], // cooperativeDisputeProof
          [], // initialDisputeProof
          [], // finalDisputeProof
          [], // flashloans
          0, // hub_id
        ]]
      );

      await expect(
        depository.processBatchWithHanko(encodedBatch, await mockProvider.getAddress(), "0x", 1)
      ).to.emit(depository, "ReserveTransferred").withArgs(senderEntity, receiverEntity, tokenId, amount);

      const remainingSender = await depository._reserves(senderEntity, tokenId);
      const receiverBalance = await depository._reserves(receiverEntity, tokenId);
      expect(remainingSender).to.equal(1_000n - amount);
      expect(receiverBalance).to.equal(amount);

      const storedNonce = await depository.entityNonces(entityToAddress(senderEntity));
      expect(storedNonce).to.equal(1n);
    });
  });

  describe("Debt enforcement FIFO", function () {
    it("applies partial repayments in order with enforceDebts", async function () {
      const { depository, admin, user1, user2 } = await loadFixture(deployDepositoryFixture);

      const debtor = addressToEntity(admin.address);
      const creditorA = addressToEntity(user1.address);
      const creditorB = addressToEntity(user2.address);
      const tokenId = 2;

      await depository.debugFundReserves(debtor, tokenId, 100n);
      await depository.createDebt(debtor, creditorA, tokenId, 70n);
      await depository.createDebt(debtor, creditorB, tokenId, 50n);

      await depository["enforceDebts(bytes32,uint256,uint256)"](debtor, tokenId, 1);

      expect(await depository._reserves(creditorA, tokenId)).to.equal(70n);
      expect(await depository._reserves(debtor, tokenId)).to.equal(30n);

      let { currentDebtIndex } = await depository.getDebts(debtor, tokenId);
      expect(currentDebtIndex).to.equal(1n);

      await depository.debugFundReserves(debtor, tokenId, 40n);
      await depository["enforceDebts(bytes32,uint256)"](debtor, tokenId);

      expect(await depository._reserves(creditorB, tokenId)).to.equal(50n);
      expect(await depository._reserves(debtor, tokenId)).to.equal(20n);

      const { currentDebtIndex: postIndex } = await depository.getDebts(debtor, tokenId);
      expect(postIndex).to.equal(0n);

      const score = await depository.entityScores(debtor);
      expect(score.successfulRepayments).to.equal(2n);
      expect(score.totalActiveDebts).to.equal(0n);
    });
  });

  describe("Cooperative dispute flows", function () {
    it("finalizes channel via cooperative dispute proof", async function () {
      const { depository, admin, user1 } = await loadFixture(deployDepositoryFixture);

      const tokenId = 3;
      const collateralAmount = 50n;

      const leftEntity = addressToEntity(admin.address);
      const rightEntity = addressToEntity(user1.address);

      await depository.debugFundReserves(leftEntity, tokenId, collateralAmount);

      await depository.connect(admin).prefundAccount(rightEntity, tokenId, collateralAmount);

      const proofbody = {
        offdeltas: [0n],
        tokenIds: [BigInt(tokenId)],
        subcontracts: [] as any[],
      };

      const proofbodyEncoded = coder.encode(
        ["tuple(int256[],uint256[],tuple(address,bytes,tuple(uint256,uint256,uint256)[])[])"],
        [[proofbody.offdeltas, proofbody.tokenIds, proofbody.subcontracts]]
      );

      const initialArguments = "0x";
      const chKey = await depository.channelKey(leftEntity, rightEntity);

      const encodedMsg = coder.encode(
        ["uint8", "bytes", "uint256", "bytes32", "bytes32"],
        [1, chKey, 0, ethers.keccak256(proofbodyEncoded), ethers.keccak256(initialArguments)]
      );

      const sig = await user1.signMessage(ethers.getBytes(ethers.keccak256(encodedMsg)));

      await expect(
        depository.connect(admin).cooperativeDisputeProof({
          counterentity: rightEntity,
          proofbody,
          initialArguments,
          finalArguments: "0x",
          sig,
        })
      ).to.emit(depository, "CooperativeClose");

      const collateral = await depository._collaterals(await depository.channelKey(leftEntity, rightEntity), tokenId);
      expect(collateral.collateral).to.equal(0n);
    });
  });
});
