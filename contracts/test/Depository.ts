import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { Depository, TokenA } from "../typechain-types";  // Adjust the import path as needed

describe("Depository", function () {
  let depository: Depository;
  let token: TokenA;
  let owner: any;
  let addr1: any;
  let addr2: any;

  beforeEach(async function () {
    [owner, addr1, addr2] = await ethers.getSigners();

    // Deploy the Token contract
    //onst Token = await ethers.getContractFactory("TokenA");

    token = await ethers.deployContract('TokenA', [1000000000000])
    //token = await Token.deploy(1000000000000) as TokenA;

    console.log("Token deployed to:", token.target.address);

    // Deploy the Depository contract
    const Depository = await ethers.getContractFactory("Depository");
    depository = await Depository.deploy() as Depository;

    console.log("Depository deployed to:", depository);

    // Mint some tokens to the owner and approve the depository
    await token.connect(owner).approve(depository.address, 1000000);

    // Set initial reserves using a setter function
    await depository.setReserves(owner.address, 0, 100000000);
    await depository.setReserves(owner.address, 1, 100000000);
  });

  it("should transfer reserves to another user", async function () {
    await depository.connect(owner).reserveToReserve({
      receiver: addr1.address,
      tokenId: 0,
      amount: 1000
    });

    expect(await depository.getReserves(owner.address, 0)).to.equal(999999000);
    expect(await depository.getReserves(addr1.address, 0)).to.equal(1000);
  });

  it("should transfer reserves to collateral", async function () {
    await depository.connect(owner).reserveToCollateral({
      tokenId: 0,
      receiver: addr1.address,
      pairs: [
        { addr: addr2.address, amount: 1000 }
      ]
    });

    const ch_key = ethers.utils.solidityPack(
      ['address', 'address'],
      [addr1.address < addr2.address ? addr1.address : addr2.address, addr1.address < addr2.address ? addr2.address : addr1.address]
    );

    expect(await depository.getReserves(owner.address, 0)).to.equal(999999000);
    const collateral = await depository.getCollaterals(ch_key, 0);
    expect(collateral.collateral).to.equal(1000);
    expect(collateral.ondelta).to.equal(1000);
  });
});