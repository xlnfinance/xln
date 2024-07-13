import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import hre from "hardhat";
import { Contract, AbiCoder, Signer } from "ethers";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Depository, SubcontractProvider, EntityProvider, SubcontractProvider__factory } from "../typechain-types";


const coder = AbiCoder.defaultAbiCoder()


describe("Depository", function () {
  let depository: Depository;
  let scProvider: SubcontractProvider;
  
  let erc20: Contract, erc20id: bigint;
  let erc721: Contract, erc721id: bigint;
  let erc1155: Contract, erc1155id: bigint;

  let user0: HardhatEthersSigner, user1: HardhatEthersSigner, user2: HardhatEthersSigner;


  async function deployContracts() {
    // Contracts are deployed using the first signer/account by default
    [user0, user1, user2] = await hre.ethers.getSigners();

    // Deploy ERC20 mock contract
    const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
    erc20 = await ERC20Mock.deploy("ERC20Mock", "ERC20", 1000000);
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


    const Depository = await hre.ethers.getContractFactory("Depository");
    depository = await Depository.deploy();
    await depository.waitForDeployment();

    const SubcontractProvider = await hre.ethers.getContractFactory("SubcontractProvider");
    scProvider = await SubcontractProvider.deploy();
    await scProvider.waitForDeployment();



    return { erc20, erc721, erc1155, depository, user0, user1, user2 };
  }

  before(async function () {
    const contracts = await loadFixture(deployContracts);
    depository = contracts.depository;
    erc20 = contracts.erc20;
    erc721 = contracts.erc721;
    erc1155 = contracts.erc1155;
    user0 = contracts.user0;
    user1 = contracts.user1;
    user2 = contracts.user2;
  });

  describe("Deployment", function () {

    it("should transfer ERC20 token to reserve", async function () {
      const packedToken = await depository.packTokenReference(0, await erc20.getAddress(), 0);
      await erc20.approve(await depository.getAddress(), 10000);


      expect(await erc20.balanceOf(user0.address)).to.equal(1000000);

      //await erc20.transfer(await depository.getAddress(), 100000);

      await depository.externalTokenToReserve({ packedToken, internalTokenId: 0, amount: 10000 });

      erc20id = await depository.getTokensLength() - 1n;

      const reserve = await depository._reserves(user0.address, erc20id);

      expect(reserve).to.equal(10000);

      expect(await erc20.balanceOf(user0.address)).to.equal(990000);

    });
    

    it("should transfer ERC721 token to reserve", async function () {
      const packedToken = await depository.packTokenReference(1n, await erc721.getAddress(), 1);

      
      await erc721.approve(await depository.getAddress(), 1);
      expect(await erc721.ownerOf(1)).to.equal(user0.address);

      //await erc721.transferFrom(user0.address, await depository.getAddress(), 1n);
      //console.log('off ', user0.address, await depository.getAddress(), 1);

      await depository.externalTokenToReserve({ receiver: user0.address, packedToken, internalTokenId: 0, amount: 1 });
      erc721id = await depository.getTokensLength() - 1n;
      const reserve = await depository._reserves(user0.address, erc721id);

      expect(await erc721.ownerOf(1)).to.equal(await depository.getAddress());

      expect(reserve).to.equal(1);
    })

    

    it("should transfer ERC1155 token to reserve", async function () {
      const packedToken = await depository.packTokenReference(2, await erc1155.getAddress(), 0);
      await erc1155.setApprovalForAll(await depository.getAddress(), true);

      expect(await erc1155.balanceOf(user0.address, 0)).to.equal(100);

      await depository.externalTokenToReserve({ packedToken, internalTokenId: 0, amount: 50 });
      erc1155id = await depository.getTokensLength() - 1n;

      const reserve = await depository._reserves(user0.address, erc1155id);

      expect(reserve).to.equal(50);

      expect(await erc1155.balanceOf(user0.address, 0)).to.equal(50);

    })
    




    it("should transfer ERC20 token from reserve to another reserve", async function () {
      await depository.reserveToReserve({ receiver: user1.address, tokenId: erc20id, amount: 50 });
      const reserveUser1 = await depository._reserves(user1.address, erc20id);
      const reserveUser0 = await depository._reserves(user0.address, erc20id);

      expect(reserveUser1).to.equal(50);
      expect(reserveUser0).to.equal(9950);
    });


    it("should transfer ERC20 token from reserve to collateral", async function () {
      await depository.reserveToCollateral({
        tokenId: erc20id,
        receiver: user0.address,
        pairs: [{ addr: user1.address, amount: 50 }]
      });

      const collateral = await depository._collaterals(await depository.channelKey(user0.address, user1.address), erc20id);
      const reserve = await depository._reserves(user0.address, erc20id);

      expect(collateral.collateral).to.equal(50);
      expect(reserve).to.equal(9900);
    });






    it("should finalizeChannel()", async function () {
      const proofBody = {
        offdeltas: [25, -5, -10],
        tokenIds: [erc20id, erc721id, erc1155id],
        subcontracts: []
      };

      const leftArguments = coder.encode(["bytes"], ["0x"]);
      const rightArguments = coder.encode(["bytes"], ["0x"]);

      await depository.finalizeChannel(user0.address, user1.address, proofBody, leftArguments, rightArguments);

      const reserveUser0 = await depository._reserves(user0.address, erc20id);
      const reserveUser1 = await depository._reserves(user1.address, erc20id);

      expect(await depository._activeDebts(user1.address)).to.equal(2);
      const debt = (await depository.getDebts(user1.address, erc721id))[0][0]

      // check amount and creditor
      expect(debt[0]).to.equal(5);
      expect(debt[1]).to.equal(user0.address);

      expect(reserveUser0).to.equal(9925);  // 25 collateral goes back to user0
      expect(reserveUser1).to.equal(75);    // 25 for user1
    });
    





    it("should transfer ERC20 token back", async function () {

      expect(await erc20.balanceOf(user0.address)).to.equal(990000);

      await depository.reserveToExternalToken({ receiver: user0.address, tokenId: erc20id, amount: 100 });

      const balance = await erc20.balanceOf(user0.address);
      expect(balance).to.equal(990100);

    });

      
    it("should transfer ERC721 token back", async function () {

      await depository.reserveToExternalToken({ receiver: user0.address, tokenId: erc721id, amount: 1 });

      const ownerOfToken = await erc721.ownerOf(1);
      expect(ownerOfToken).to.equal(user0.address);

    });



    it("should transfer ERC1155 token back", async function () {


      await depository.reserveToExternalToken({ receiver: user0.address, tokenId: erc1155id, amount: 50 });
      const balance = await erc1155.balanceOf(user0.address, 0);
      expect(balance).to.equal(100);

    });



    it("should process cooperative dispute proof correctly", async function () {
      // Initial collateral for channel 0-1 for tokens 0 and 2
      await depository.reserveToCollateral({
        tokenId: erc20id,
        receiver: user0.address,
        pairs: [{ addr: user1.address, amount: 50 }]
      });

      await depository.reserveToCollateral({
        tokenId: erc1155id,
        receiver: user0.address,
        pairs: [{ addr: user1.address, amount: 50 }]
      });

    
      // Prepare dispute proof


      const getAbiEntry = (name: string) => SubcontractProvider__factory.abi.find(entry => entry.name === name);

      const testhash = ethers.keccak256(Buffer.alloc(32));
      console.log(testhash)
      console.log(await scProvider.hashToBlock(testhash));

      // To encode an array of structs for use in SubcontractParams
      const payment: SubcontractProvider.SubcontractParamsStruct = {
        deltaIndex: 0,
        amount: 100,
        revealedUntilBlock: 123456,
        hash: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef"
      };

      const swap: SubcontractProvider__factory.Swap = {
        addIndex: 1,
        addAmount: 200,
        subIndex: 2,
        subAmount: 50
      };

      const batch: SubcontractProvider__factory.Batch = {
        payment: [payment], 
        swap: [swap]
      }
      

      SubcontractProvider__factory.abi.forEach(entry => console.log(entry.name))
      const encodedData = coder.encode(
        [
          getAbiEntry('Batch').inputs
        ],
        [batch]
      );

      console.log("Encoded SubcontractParams Data:", encodedData);
      return


      const proofbody: Depository.ProofBodyStruct = { 
        offdeltas: [10,10], 
        tokenIds: [0, 2], 
        subcontracts: []
      };

      proofbody.subcontracts.push({ subcontractProviderAddress: user1.address, 
        data: encodedData,
        allowences: [
          { deltaIndex: 0, incrementDeltaAllowence: 10, decrementDeltaAllowence: 5 },
          { deltaIndex: 1, incrementDeltaAllowence: 20, decrementDeltaAllowence: 15 },
        ] 
      })

      const initialArguments = coder.encode(["uint"], [0]);
      const finalArguments = coder.encode(["uint"], [0]);

      // Sign the proof
      const encoded_msg = coder.encode(
        ['uint8', 'bytes', 'uint', 'bytes32', 'bytes32'],
        [2, await depository.channelKey(user0.address, user1.address), 0, ethers.utils.keccak256(coder.encode(['uint'], [0])), ethers.utils.keccak256(initialArguments)]
      );
      const hash = ethers.utils.keccak256(encoded_msg);
      const sig = await user1.signMessage(ethers.utils.arrayify(hash));

      // Call cooperativeDisputeProof
      await depository.cooperativeDisputeProof({
        peer: user1.address,
        proofbody: proofbody,
        initialArguments: initialArguments,
        finalArguments: finalArguments,
        sig: sig,
      });

      // Validate results
      const reserveUser0 = await depository._reserves(user0.address, 0);
      const reserveUser1 = await depository._reserves(user1.address, 0);

      expect(reserveUser0).to.equal(9950);  // 10000 initial - 50 collateral
      expect(reserveUser1).to.equal(0);    // No reserve for user1

      const collateral = await depository._collaterals(await depository.channelKey(user0.address, user1.address), 0);
      expect(collateral.collateral).to.equal(50);
    });



  });


  
});
