/**
 * Fund hub wallet with ERC20 tokens
 * Usage: npx hardhat run scripts/fund-hub.cjs --network localhost
 */
const hre = require("hardhat");

async function main() {
  const hubWalletAddress = "0x500dc3002D0B860d8C8Eb3426D0504D16E86b29C";
  const amount = hre.ethers.parseUnits("1000000000", 18); // 1B tokens
  const ethAmount = hre.ethers.parseEther("1000"); // 1000 ETH for gas

  const tokens = [
    { symbol: "USDC", address: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9" },
    { symbol: "WETH", address: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707" },
    { symbol: "USDT", address: "0x0165878A594ca255338adfa4d48449f69242Eb8F" },
  ];

  console.log(`💰 Funding hub wallet: ${hubWalletAddress}\n`);

  // Fund with ETH first (for gas)
  const [deployer] = await hre.ethers.getSigners();
  console.log(`💸 Sending ${ethAmount} ETH for gas...`);
  const ethTx = await deployer.sendTransaction({
    to: hubWalletAddress,
    value: ethAmount,
  });
  await ethTx.wait();
  console.log(`   ✅ ETH transferred\n`);

  for (const token of tokens) {
    console.log(`📤 ${token.symbol}:`);
    const erc20 = await hre.ethers.getContractAt("ERC20Mock", token.address);

    // Check deployer balance
    const balance = await erc20.balanceOf(deployer.address);
    console.log(`   Deployer has: ${hre.ethers.formatUnits(balance, 18)}`);

    // Mint if needed (ERC20Mock allows anyone to mint)
    if (balance < amount) {
      console.log(`   Minting ${hre.ethers.formatUnits(amount - balance, 18)} tokens...`);
      const mintTx = await erc20.mint(deployer.address, amount);
      await mintTx.wait();
    }

    // Transfer to hub
    const tx = await erc20.transfer(hubWalletAddress, amount);
    await tx.wait();
    console.log(`   ✅ Transferred 1B tokens`);
  }

  console.log("\n✅ Hub wallet funded with all tokens!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
