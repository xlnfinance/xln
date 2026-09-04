import { expect } from "chai";
import hre from "hardhat";
import {
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from "../helpers/hanko.ts";

const { ethers, networkHelpers } = await hre.network.getOrCreate("hardhat");
const { loadFixture } = networkHelpers;

/**
 * processBatch performs exactly one CALL whose target is taken from the batch
 * itself: `DeltaTransformer(reveal.transformer).revealSecret(...)`. It runs
 * while the reentrancy flag is set and flash-minted reserves are live, so the
 * target must be the immutable canonical transformer and nothing else.
 */
describe("canonical transformer secret reveal", function () {
  async function deployFixture() {
    const [admin, signer] = await ethers.getSigners();
    const entityProvider = await deployEntityProvider(admin.address);
    const { depository, deltaTransformer } = await deployDepositoryStack(await entityProvider.getAddress());
    const ForeignFactory = await ethers.getContractFactory("DeltaTransformer");
    const foreignTransformer = await ForeignFactory.deploy();
    await foreignTransformer.waitForDeployment();
    return { depository, deltaTransformer, foreignTransformer, signer };
  }

  async function submitReveal(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    transformer: string,
    secret: string,
  ) {
    const { depository, signer } = fixture;
    const entityId = singleSignerLazyEntityId(signer.address);
    const batch = emptyBatch({ revealSecrets: [{ transformer, secret }] });
    const encodedBatch = encodeBatch(batch);
    const nonce = (await depository.entityNonces(entityId)) + 1n;
    const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, nonce);
    const hanko = buildSingleSignerHanko(entityId, batchHash, deriveHardhatPrivateKey(1));
    return depository.connect(signer).processBatch(encodedBatch, hanko, nonce);
  }

  it("records a reveal through the canonical transformer", async function () {
    const fixture = await loadFixture(deployFixture);
    const secret = ethers.keccak256(ethers.toUtf8Bytes("canonical-secret"));
    const canonical = await fixture.deltaTransformer.getAddress();
    await expect(submitReveal(fixture, canonical, secret)).to.not.revert(ethers);
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [secret]));
    expect(await fixture.deltaTransformer.hashToTimestamp(hash)).to.not.equal(0n);
  });

  it("rejects a reveal routed to a foreign transformer with the same ABI", async function () {
    const fixture = await loadFixture(deployFixture);
    const secret = ethers.keccak256(ethers.toUtf8Bytes("foreign-secret"));
    const foreign = await fixture.foreignTransformer.getAddress();
    await expect(submitReveal(fixture, foreign, secret)).to.be.revertedWithCustomError(fixture.depository, "E2");
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [secret]));
    expect(await fixture.foreignTransformer.hashToTimestamp(hash)).to.equal(0n);
    expect(await fixture.deltaTransformer.hashToTimestamp(hash)).to.equal(0n);
  });

  it("rejects a zero transformer address", async function () {
    const fixture = await loadFixture(deployFixture);
    const secret = ethers.keccak256(ethers.toUtf8Bytes("zero-secret"));
    await expect(submitReveal(fixture, ethers.ZeroAddress, secret)).to.be.revertedWithCustomError(fixture.depository, "E2");
  });
});
