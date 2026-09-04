/**
 * Deploy full XLN contract stack
 * Usage: npx hardhat run scripts/deploy-stack.cjs --network localhost
 */
const hre = require("hardhat");

const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const { buildFoundationTokenListing, foundationEntityId } = require("./foundation-hanko.cjs");

const DEFAULT_HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * The Foundation single signer at genesis is foundationRecipient. Listing the
 * stablecoin needs its raw key (DEPLOYER_PRIVATE_KEY, or the well-known
 * Hardhat/Anvil account #0 on local nodes that unlock it).
 */
const resolveFoundationSignerKey = (deployerAddress) => {
  const configured = String(process.env.DEPLOYER_PRIVATE_KEY || "").trim();
  const candidates = [];
  if (configured) candidates.push(configured.startsWith("0x") ? configured : `0x${configured}`);
  candidates.push(
    hre.ethers.HDNodeWallet.fromPhrase(DEFAULT_HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/0").privateKey,
  );
  for (const key of candidates) {
    if (new hre.ethers.Wallet(key).address.toLowerCase() === deployerAddress.toLowerCase()) return key;
  }
  throw new Error(`FOUNDATION_SIGNER_KEY_UNAVAILABLE:${deployerAddress}`);
};

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

  // 3. Deploy the immutable canonical transformer and both code-size libraries.
  console.log("3️⃣ Deploying DeltaTransformer + Depository libraries...");
  const DeltaTransformer = await hre.ethers.getContractFactory("DeltaTransformer");
  const deltaTransformer = await DeltaTransformer.deploy();
  await deltaTransformer.waitForDeployment();
  const deltaTransformerAddr = await deltaTransformer.getAddress();
  const deltaTransformerDeployment = await deploymentEvidence(
    deltaTransformer,
    deltaTransformerAddr,
    "DELTA_TRANSFORMER",
  );
  const DepositoryBounds = await hre.ethers.getContractFactory("DepositoryBounds");
  const depositoryBounds = await DepositoryBounds.deploy();
  await depositoryBounds.waitForDeployment();
  const depositoryBoundsAddr = await depositoryBounds.getAddress();
  const depositoryBoundsDeployment = await deploymentEvidence(
    depositoryBounds,
    depositoryBoundsAddr,
    "DEPOSITORY_BOUNDS",
  );
  const HashLadderRegistry = await hre.ethers.getContractFactory("HashLadderRegistry");
  const hashLadderRegistry = await HashLadderRegistry.deploy();
  await hashLadderRegistry.waitForDeployment();
  const hashLadderRegistryAddr = await hashLadderRegistry.getAddress();
  const hashLadderRegistryDeployment = await deploymentEvidence(
    hashLadderRegistry,
    hashLadderRegistryAddr,
    "HASH_LADDER_REGISTRY",
  );
  const NftCustody = await hre.ethers.getContractFactory("NftCustody");
  const nftCustody = await NftCustody.deploy();
  await nftCustody.waitForDeployment();
  const nftCustodyAddr = await nftCustody.getAddress();
  const nftCustodyDeployment = await deploymentEvidence(nftCustody, nftCustodyAddr, "NFT_CUSTODY");

  // 4. Deploy Depository with one immutable transformer and all linked logic.
  console.log("4️⃣ Deploying Depository...");
  const Depository = await hre.ethers.getContractFactory("Depository", {
    libraries: {
      Account: accountAddr,
      DepositoryBounds: depositoryBoundsAddr,
      HashLadderRegistry: hashLadderRegistryAddr,
      NftCustody: nftCustodyAddr,
    },
  });
  const depository = await Depository.deploy(entityProviderAddr, deltaTransformerAddr);
  await depository.waitForDeployment();
  const depositoryAddr = await depository.getAddress();
  const depositoryDeployment = await deploymentEvidence(
    depository,
    depositoryAddr,
    "DEPOSITORY",
  );
  console.log(`   Depository: ${depositoryAddr}`);

  console.log(`   DeltaTransformer: ${deltaTransformerAddr}`);

  const bindReceipt = await (await entityProvider.bindShareDepository(depositoryAddr)).wait();
  if (!bindReceipt || bindReceipt.status !== 1) {
    throw new Error("SHARE_DEPOSITORY_BINDING_RECEIPT_INVALID");
  }
  if ((await entityProvider.shareDepository()).toLowerCase() !== depositoryAddr.toLowerCase()) {
    throw new Error("SHARE_DEPOSITORY_BINDING_MISMATCH");
  }

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
  // Depository.registerExternalToken is callable only by the EntityProvider.
  // Listing goes through EntityProvider.foundationRegisterExternalToken under a
  // Foundation Hanko; at genesis the Foundation board is the 1-of-1
  // foundationRecipient EOA, which must be this deployer to sign here.
  if (foundationRecipient.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `FOUNDATION_LISTING_SIGNER_MISMATCH:foundation=${foundationRecipient}:deployer=${deployer.address}`,
    );
  }
  const foundationSignerKey = resolveFoundationSignerKey(deployer.address);
  const listing = buildFoundationTokenListing(hre.ethers, {
    chainId: network.chainId,
    entityProviderAddress: entityProviderAddr,
    foundationNonce: await entityProvider.entityActionNonces(foundationEntityId(hre.ethers)),
    depository: depositoryAddr,
    tokenType: 0,
    contractAddress: stablecoinAddress,
    externalTokenId: 0,
    privateKey: foundationSignerKey,
  });
  const onchainActionHash = await entityProvider.computeFoundationActionHash(
    await entityProvider.FOUNDATION_REGISTER_TOKEN(),
    listing.argumentsHash,
    listing.actionNonce,
  );
  if (onchainActionHash.toLowerCase() !== listing.actionHash.toLowerCase()) {
    throw new Error(`FOUNDATION_ACTION_HASH_MISMATCH:${onchainActionHash}:${listing.actionHash}`);
  }
  const registration = await entityProvider.foundationRegisterExternalToken(
    depositoryAddr,
    0,
    stablecoinAddress,
    0,
    listing.hankoData,
    listing.actionNonce,
  );
  const registrationReceipt = await registration.wait();
  if (!registrationReceipt || registrationReceipt.status !== 1) {
    throw new Error("STABLECOIN_REGISTRATION_RECEIPT_INVALID");
  }
  const stablecoinTokenId = (await depository.getTokensLength()) - 1n;
  if (stablecoinTokenId !== 1n) {
    throw new Error(`STABLECOIN_TOKEN_ID_MISMATCH:expected=1:actual=${stablecoinTokenId}`);
  }
  console.log(`   USDT: ${stablecoinAddress} (tokenId 1)`);

  const result = {
    stackVersion: "V1",
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    foundationRecipient,
    entityProviderDeploymentBlock: entityProviderDeployment.deploymentBlock,
    contracts: {
      account: accountAddr,
      depositoryBounds: depositoryBoundsAddr,
      hashLadderRegistry: hashLadderRegistryAddr,
      nftCustody: nftCustodyAddr,
      hankoVerifier: hankoVerifierAddr,
      entityProvider: entityProviderAddr,
      depository: depositoryAddr,
      deltaTransformer: deltaTransformerAddr,
    },
    evmContracts: {
      account: accountDeployment,
      depositoryBounds: depositoryBoundsDeployment,
      hashLadderRegistry: hashLadderRegistryDeployment,
      nftCustody: nftCustodyDeployment,
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
