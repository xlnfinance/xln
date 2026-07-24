/**
 * Deploy a new immutable Depository against an already deployed Account
 * library and EntityProvider. This is the canonical path when only Depository
 * bytecode changes: unchanged verified dependencies keep their addresses.
 */
const hre = require("hardhat");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const requiredAddress = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name}_INVALID`);
  }
  return hre.ethers.getAddress(value);
};

const requiredPositiveInteger = (name) => {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
};

const requireContract = async (name, address) => {
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${name}_CODE_MISSING:${address}`);
  }
};

async function main() {
  const accountAddress = requiredAddress("XLN_ACCOUNT_ADDRESS");
  const entityProviderAddress = requiredAddress("XLN_ENTITY_PROVIDER_ADDRESS");
  const stablecoinAddress = requiredAddress("XLN_STABLECOIN_ADDRESS");
  const disputeDelayBlocks = requiredPositiveInteger("XLN_DISPUTE_DELAY_BLOCKS");
  const outputPath = String(process.env.XLN_DEPLOY_OUTPUT || "").trim();
  if (!outputPath) throw new Error("XLN_DEPLOY_OUTPUT_REQUIRED");

  await Promise.all([
    requireContract("ACCOUNT", accountAddress),
    requireContract("ENTITY_PROVIDER", entityProviderAddress),
    requireContract("STABLECOIN", stablecoinAddress),
  ]);

  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const Depository = await hre.ethers.getContractFactory("Depository", {
    libraries: { Account: accountAddress },
  });
  const depository = await Depository.deploy(entityProviderAddress, disputeDelayBlocks);
  await depository.waitForDeployment();
  const address = await depository.getAddress();
  const deploymentTransaction = depository.deploymentTransaction();
  if (!deploymentTransaction) throw new Error("DEPOSITORY_DEPLOYMENT_TRANSACTION_MISSING");
  const deploymentReceipt = await deploymentTransaction.wait();
  if (!deploymentReceipt || deploymentReceipt.status !== 1) {
    throw new Error("DEPOSITORY_DEPLOYMENT_RECEIPT_INVALID");
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

  const result = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    reused: {
      account: accountAddress,
      entityProvider: entityProviderAddress,
      stablecoin: stablecoinAddress,
    },
    depository: {
      address,
      deploymentBlock: deploymentReceipt.blockNumber,
      transactionHash: deploymentTransaction.hash,
    },
    stablecoinRegistration: {
      transactionHash: registration.hash,
      blockNumber: registrationReceipt.blockNumber,
    },
    disputeDelayBlocks,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
