import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import type { Depository } from "../typechain-types/index.js";
import { Contract } from "ethers";

describe("Depository", function () {
  let user0: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let depository: Depository;
  let erc20: Contract;
  let erc721: Contract;
  let erc1155: Contract;

  async function deployFixture() {
    [user0, user1] = await hre.ethers.getSigners();

    // Deploy EntityProvider
    const EntityProviderFactory = await hre.ethers.getContractFactory("EntityProvider");
    const entityProvider = await EntityProviderFactory.deploy();
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

    // Deploy ERC20 mock contract
    const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
    erc20 = await ERC20Mock.deploy("ERC20Mock", "ERC20", 1_000_000);
    await erc20.waitForDeployment();

    // Deploy ERC721 mock contract
    const ERC721Mock = await hre.ethers.getContractFactory("ERC721Mock");
    erc721 = await ERC721Mock.deploy("ERC721Mock", "ERC721");
    await erc721.waitForDeployment();
    await erc721.mint(user0.address, 1);

    // Deploy ERC1155 mock contract
    const ERC1155Mock = await hre.ethers.getContractFactory("ERC1155Mock");
    erc1155 = await ERC1155Mock.deploy();
    await erc1155.waitForDeployment();
    await erc1155.mint(user0.address, 0, 100, "0x");

    return { depository, erc20, erc721, erc1155, user0, user1 };
  }

  it("ERC20 deposit to reserve", async function () {
    const { depository, erc20 } = await loadFixture(deployFixture);

    await erc20.approve(await depository.getAddress(), 10_000);
    expect(await erc20.balanceOf(user0.address)).to.equal(1_000_000);

    await depository.externalTokenToReserve({
      entity: ethers.ZeroHash,
      contractAddress: await erc20.getAddress(),
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: 10_000,
    });

    const erc20id = await depository.getTokensLength() - 1n;
    const reserve = await depository._reserves(user0.address, erc20id);

    expect(reserve).to.equal(10_000);
    expect(await erc20.balanceOf(user0.address)).to.equal(990_000);
  });

  it("ERC721 deposit to reserve", async function () {
    const { depository, erc721 } = await loadFixture(deployFixture);

    await erc721.approve(await depository.getAddress(), 1);
    expect(await erc721.ownerOf(1)).to.equal(user0.address);

    await depository.externalTokenToReserve({
      entity: ethers.ZeroHash,
      contractAddress: await erc721.getAddress(),
      externalTokenId: 1,
      tokenType: 1,
      internalTokenId: 0,
      amount: 1,
    });

    const erc721id = await depository.getTokensLength() - 1n;
    const reserve = await depository._reserves(user0.address, erc721id);

    expect(await erc721.ownerOf(1)).to.equal(await depository.getAddress());
    expect(reserve).to.equal(1);
  });

  it("ERC1155 deposit to reserve", async function () {
    const { depository, erc1155 } = await loadFixture(deployFixture);

    await erc1155.setApprovalForAll(await depository.getAddress(), true);
    expect(await erc1155.balanceOf(user0.address, 0)).to.equal(100);

    await depository.externalTokenToReserve({
      entity: ethers.ZeroHash,
      contractAddress: await erc1155.getAddress(),
      externalTokenId: 0,
      tokenType: 2,
      internalTokenId: 0,
      amount: 50,
    });

    const erc1155id = await depository.getTokensLength() - 1n;
    const reserve = await depository._reserves(user0.address, erc1155id);

    expect(reserve).to.equal(50);
    expect(await erc1155.balanceOf(user0.address, 0)).to.equal(50);
  });

  it("reserveToReserve transfers between entities", async function () {
    const { depository } = await loadFixture(deployFixture);

    const fromEntity = ethers.zeroPadValue(user0.address, 32);
    const toEntity = ethers.zeroPadValue(user1.address, 32);
    const tokenId = 1;

    await depository.mintToReserve(fromEntity, tokenId, 1_000n);

    await expect(
      depository.connect(user0).reserveToReserve(fromEntity, toEntity, tokenId, 250n)
    ).to.not.be.reverted;

    const reserveFrom = await depository._reserves(fromEntity, tokenId);
    const reserveTo = await depository._reserves(toEntity, tokenId);

    expect(reserveFrom).to.equal(750n);
    expect(reserveTo).to.equal(250n);
  });
});
