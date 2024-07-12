import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import hre from "hardhat";
import { Contract, AbiCoder } from "ethers";
import { ethers } from "hardhat";


const coder = AbiCoder.defaultAbiCoder()


describe("Depository", function () {
  let depository: Contract;

  let erc20: Contract;
  let erc721: Contract;
  let erc1155: Contract;

  let owner, user1, user2;


  async function deployContracts() {
    // Contracts are deployed using the first signer/account by default
    [owner, user1, user2] = await hre.ethers.getSigners();

    // Deploy ERC20 mock contract
    const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
    erc20 = await ERC20Mock.deploy("ERC20Mock", "ERC20", 1000000);
    await erc20.waitForDeployment();

    
    // Deploy ERC721 mock contract
    const ERC721Mock = await hre.ethers.getContractFactory("ERC721Mock");
    erc721 = await ERC721Mock.deploy("ERC721Mock", "ERC721");
    await erc721.waitForDeployment();

    await erc721.mint(owner.address, 1);

    // Deploy ERC1155 mock contract
    const ERC1155Mock = await hre.ethers.getContractFactory("ERC1155Mock");
    erc1155 = await ERC1155Mock.deploy();
    await erc1155.waitForDeployment();

    await erc1155.mint(owner.address, 0, 100, "0x");


    const Depository = await hre.ethers.getContractFactory("Depository");
    depository = await Depository.deploy();
    await depository.waitForDeployment();


    return { erc20, erc721, erc1155, depository, owner, user1, user2 };
  }

  before(async function () {
    const contracts = await loadFixture(deployContracts);
    depository = contracts.depository;
    erc20 = contracts.erc20;
    erc721 = contracts.erc721;
    erc1155 = contracts.erc1155;
    owner = contracts.owner;
    user1 = contracts.user1;
    user2 = contracts.user2;
  });

  describe("Deployment", function () {

    it("should transfer ERC20 token to reserve", async function () {
      const packedToken = await depository.packTokenReference(0, await erc20.getAddress(), 0);
      await erc20.approve(await depository.getAddress(), 10000);

      expect(await erc20.balanceOf(owner.address)).to.equal(1000000);

      //await erc20.transfer(await depository.getAddress(), 100000);

      await depository.externalTokenToReserve({ receiver: owner.address, packedToken, internalTokenId: 0, amount: 10000 });

      const reserve = await depository._reserves(owner.address, 0);

      expect(reserve).to.equal(10000);

      expect(await erc20.balanceOf(owner.address)).to.equal(990000);

    });
    

    it("should transfer ERC721 token to reserve", async function () {
      const packedToken = await depository.packTokenReference(1n, await erc721.getAddress(), 1);

      
      await erc721.approve(await depository.getAddress(), 1);
      expect(await erc721.ownerOf(1)).to.equal(owner.address);

      //await erc721.transferFrom(owner.address, await depository.getAddress(), 1n);
      //console.log('off ', owner.address, await depository.getAddress(), 1);

      await depository.externalTokenToReserve({ receiver: owner.address, packedToken, internalTokenId: 0, amount: 1 });
      const reserve = await depository._reserves(owner.address, 1);

      expect(await erc721.ownerOf(1)).to.equal(await depository.getAddress());

      expect(reserve).to.equal(1);
    })

    

    it("should transfer ERC1155 token to reserve", async function () {
      const packedToken = await depository.packTokenReference(2, await erc1155.getAddress(), 0);
      await erc1155.setApprovalForAll(await depository.getAddress(), true);

      expect(await erc1155.balanceOf(owner.address, 0)).to.equal(100);

      await depository.externalTokenToReserve({ receiver: owner.address, packedToken, internalTokenId: 0, amount: 50 });

      const reserve = await depository._reserves(owner.address, 2);

      expect(reserve).to.equal(50);

      expect(await erc1155.balanceOf(owner.address, 0)).to.equal(50);

    })
    




    it("should transfer ERC20 token from reserve to another reserve", async function () {
      await depository.reserveToReserve({ receiver: user1.address, tokenId: 0, amount: 50 });
      const reserveUser1 = await depository._reserves(user1.address, 0);
      const reserveOwner = await depository._reserves(owner.address, 0);

      expect(reserveUser1).to.equal(50);
      expect(reserveOwner).to.equal(9950);
    });


    it("should transfer ERC20 token from reserve to collateral", async function () {
      await depository.reserveToCollateral({
        tokenId: 0,
        receiver: owner.address,
        pairs: [{ addr: user1.address, amount: 50 }]
      });

      const collateral = await depository._collaterals(await depository.channelKey(owner.address, user1.address), 0);
      const reserve = await depository._reserves(owner.address, 0);

      expect(collateral.collateral).to.equal(50);
      expect(reserve).to.equal(9900);
    });






    it("should finalize channel after reserveToCollateral", async function () {
      const proofBody = {
        offdeltas: [25],
        tokenIds: [0],
        subcontracts: []
      };

      const leftArguments = coder.encode(["bytes"], ["0x"]);
      const rightArguments = coder.encode(["bytes"], ["0x"]);

      await depository.finalizeChannel(owner.address, user1.address, proofBody, leftArguments, rightArguments);

      const reserveOwner = await depository._reserves(owner.address, 0);
      const reserveUser1 = await depository._reserves(user1.address, 0);

      expect(reserveOwner).to.equal(9925);  // 25 collateral goes back to owner
      expect(reserveUser1).to.equal(75);    // 25 for user1
    });
    





    it("should transfer ERC20 token back", async function () {

      expect(await erc20.balanceOf(owner.address)).to.equal(990000);

      await depository.reserveToExternalToken({ receiver: owner.address, tokenId: 0, amount: 100 });

      const balance = await erc20.balanceOf(owner.address);
      expect(balance).to.equal(990100);

    });

      
    it("should transfer ERC721 token back", async function () {

      await depository.reserveToExternalToken({ receiver: owner.address, tokenId: 1, amount: 1 });

      const ownerOfToken = await erc721.ownerOf(1);
      expect(ownerOfToken).to.equal(owner.address);

    });



    it("should transfer ERC1155 token back", async function () {


      await depository.reserveToExternalToken({ receiver: owner.address, tokenId: 2, amount: 50 });
      const balance = await erc1155.balanceOf(owner.address, 0);
      expect(balance).to.equal(100);

    });




  });


  
});
