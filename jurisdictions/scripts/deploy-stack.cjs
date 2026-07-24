/**
 * Deploy full XLN contract stack
 * Usage: npx hardhat run scripts/deploy-stack.cjs --network localhost
 */
const hre = require("hardhat");

const disputeDelayBlocks = Number(process.env.XLN_DISPUTE_DELAY_BLOCKS);
if (!Number.isSafeInteger(disputeDelayBlocks) || disputeDelayBlocks <= 0 || disputeDelayBlocks > 65_535) {
  throw new Error(`XLN_DISPUTE_DELAY_BLOCKS_INVALID:${process.env.XLN_DISPUTE_DELAY_BLOCKS || 'missing'}`);
}
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const deploymentEvidence = async (contract, address, label) => {
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error(`${label}_DEPLOYMENT_TRANSACTION_MISSING`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1 || !Number.isSafeInteger(receipt.blockNumber)) {
    throw new Error(`${label}_DEPLOYMENT_RECEIPT_INVALID`);
  }
  return {
    address,
    deploymentBlock: receipt.blockNumber,
    transactionHash: transaction.hash,
  };
};

async function main() {
  console.log("🚀 Deploying XLN Contract Stack...\n");
  const network = await hre.ethers.provider.getNetwork();
  const [deployer] = await hre.ethers.getSigners();
  const foundationRecipient = hre.ethers.getAddress(
    process.env.XLN_FOUNDATION_ADDRESS || deployer.address
  );

  // 1. Deploy Account library
  console.log("1️⃣ Deploying Account library...");
  const Account = await hre.ethers.getContractFactory("Account");
  const account = await Account.deploy();
  await account.waitForDeployment();
  const accountAddr = await account.getAddress();
  const accountDeployment = await deploymentEvidence(account, accountAddr, "ACCOUNT");
  console.log(`   Account: ${accountAddr}`);

  // 2. Deploy bounded Hanko verifier and linked EntityProvider
  console.log("2️⃣ Deploying HankoVerifier + EntityProvider...");
  const HankoVerifier = await hre.ethers.getContractFactory("HankoVerifier");
  const hankoVerifier = await HankoVerifier.deploy();
  await hankoVerifier.waitForDeployment();
  const hankoVerifierAddr = await hankoVerifier.getAddress();
  const hankoVerifierDeployment = await deploymentEvidence(
    hankoVerifier,
    hankoVerifierAddr,
    "HANKO_VERIFIER",
  );
  const EntityProvider = await hre.ethers.getContractFactory("EntityProvider", {
    libraries: { HankoVerifier: hankoVerifierAddr },
  });
  const entityProvider = await EntityProvider.deploy(foundationRecipient);
  await entityProvider.waitForDeployment();
  const entityProviderAddr = await entityProvider.getAddress();
  const entityProviderDeployment = await deploymentEvidence(
    entityProvider,
    entityProviderAddr,
    "ENTITY_PROVIDER",
  );
  console.log(`   EntityProvider: ${entityProviderAddr}`);
  console.log(`   HankoVerifier: ${hankoVerifierAddr}`);
  console.log(`   Foundation recipient: ${foundationRecipient}`);

  // 3. Deploy Depository (needs Account library linked)
  console.log("3️⃣ Deploying Depository...");
  const Depository = await hre.ethers.getContractFactory("Depository", {
    libraries: {
      Account: accountAddr,
    },
  });
  const depository = await Depository.deploy(entityProviderAddr, disputeDelayBlocks);
  await depository.waitForDeployment();
  const depositoryAddr = await depository.getAddress();
  const depositoryDeployment = await deploymentEvidence(
    depository,
    depositoryAddr,
    "DEPOSITORY",
  );
  console.log(`   Depository: ${depositoryAddr}`);

  // 4. Deploy DeltaTransformer
  console.log("4️⃣ Deploying DeltaTransformer...");
  const DeltaTransformer = await hre.ethers.getContractFactory("DeltaTransformer");
  const deltaTransformer = await DeltaTransformer.deploy();
  await deltaTransformer.waitForDeployment();
  const deltaTransformerAddr = await deltaTransformer.getAddress();
  const deltaTransformerDeployment = await deploymentEvidence(
    deltaTransformer,
    deltaTransformerAddr,
    "DELTA_TRANSFORMER",
  );
  console.log(`   DeltaTransformer: ${deltaTransformerAddr}`);

  // 5. Register the canonical external stablecoin as tokenId 1. Public
  // testnets deploy an explicit faucet token when no address is configured;
  // mainnet callers must provide the real token address.
  let stablecoinAddress = String(process.env.XLN_STABLECOIN_ADDRESS || "").trim();
  let stablecoinDeployment;
  if (!stablecoinAddress) {
    if (process.env.XLN_DEPLOY_TEST_STABLECOIN !== "1") {
      throw new Error("XLN_STABLECOIN_ADDRESS_REQUIRED");
    }
    const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
    const stablecoin = await ERC20Mock.deploy(
      "Tether USD Test",
      "USDT",
      6,
      hre.ethers.parseUnits("1000000", 6),
    );
    await stablecoin.waitForDeployment();
    stablecoinAddress = await stablecoin.getAddress();
    stablecoinDeployment = await deploymentEvidence(
      stablecoin,
      stablecoinAddress,
      "TEST_STABLECOIN",
    );
  } else {
    stablecoinAddress = hre.ethers.getAddress(stablecoinAddress);
  }
  const stablecoin = new hre.ethers.Contract(
    stablecoinAddress,
    ["function decimals() external view returns (uint8)"],
    deployer,
  );
  const stablecoinDecimals = Number(await stablecoin.decimals());
  if (stablecoinDecimals !== 6) {
    throw new Error(`STABLECOIN_DECIMALS_MISMATCH:expected=6:actual=${stablecoinDecimals}`);
  }
  const registration = await depository.registerExternalToken(0, stablecoinAddress, 0);
  const registrationReceipt = await registration.wait();
  if (!registrationReceipt || registrationReceipt.status !== 1) {
    throw new Error("STABLECOIN_REGISTRATION_RECEIPT_INVALID");
  }
  const tokenReference = hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint8", "address", "uint96"],
    [0, stablecoinAddress, 0],
  ));
  const stablecoinTokenId = await depository.tokenToId(tokenReference);
  if (stablecoinTokenId !== 1n) {
    throw new Error(`STABLECOIN_TOKEN_ID_MISMATCH:expected=1:actual=${stablecoinTokenId}`);
  }
  console.log(`   USDT: ${stablecoinAddress} (tokenId 1)`);

  const result = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    foundationRecipient,
    entityProviderDeploymentBlock: entityProviderDeployment.deploymentBlock,
    contracts: {
      account: accountAddr,
      hankoVerifier: hankoVerifierAddr,
      entityProvider: entityProviderAddr,
      depository: depositoryAddr,
      deltaTransformer: deltaTransformerAddr,
    },
    evmContracts: {
      account: accountDeployment,
      hankoVerifier: hankoVerifierDeployment,
      entityProvider: entityProviderDeployment,
      depository: depositoryDeployment,
      deltaTransformer: deltaTransformerDeployment,
      ...(stablecoinDeployment ? { stablecoin: stablecoinDeployment } : {}),
      stablecoinRegistration: {
        transactionHash: registration.hash,
        blockNumber: registrationReceipt.blockNumber,
      },
    },
    registeredTokens: {
      USDT: {
        address: stablecoinAddress,
        tokenId: Number(stablecoinTokenId),
        decimals: stablecoinDecimals,
      },
    },
  };

  if (process.env.XLN_DEPLOY_OUTPUT) {
    mkdirSync(dirname(process.env.XLN_DEPLOY_OUTPUT), { recursive: true });
    writeFileSync(process.env.XLN_DEPLOY_OUTPUT, JSON.stringify(result, null, 2));
  }

  console.log("\n✅ Stack deployed successfully!\n");
  console.log("Update jurisdictions.json with:");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
