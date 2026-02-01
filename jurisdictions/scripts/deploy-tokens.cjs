/**
 * Deploy ERC20 mock tokens to anvil
 * Usage: npx hardhat run scripts/deploy-tokens.cjs --network localhost
 */
const hre = require("hardhat");

async function main() {
  console.log("🪙 Deploying ERC20 Mock Tokens...\n");

  const tokens = [
    { name: "USD Coin", symbol: "USDC", decimals: 18 },
    { name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    { name: "Tether USD", symbol: "USDT", decimals: 18 },
  ];

  const deployed = [];

  // Deploy with 10B supply (enough for all faucets)
  const initialSupply = hre.ethers.parseUnits("10000000000", 18); // 10B tokens
  const hubWallet = "0x500dc3002D0B860d8C8Eb3426D0504D16E86b29C";

  for (const token of tokens) {
    console.log(`📝 Deploying ${token.symbol}...`);
    const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
    const erc20 = await ERC20Mock.deploy(token.name, token.symbol, initialSupply);
    await erc20.waitForDeployment();
    const addr = await erc20.getAddress();

    // Transfer 1B to hub wallet
    const hubAmount = hre.ethers.parseUnits("1000000000", 18);
    const tx = await erc20.transfer(hubWallet, hubAmount);
    await tx.wait();

    console.log(`   ${token.symbol}: ${addr} (1B → hub)`);
    deployed.push({ ...token, address: addr });
  }

  console.log("\n✅ All tokens deployed!\n");
  console.log("Addresses:");
  for (const token of deployed) {
    console.log(`  ${token.symbol}: ${token.address}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
