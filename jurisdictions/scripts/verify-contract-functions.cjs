const { ethers } = require("hardhat");
const fs = require('fs');

function loadDeploymentData() {
    const outputPath = process.env.XLN_DEPLOY_OUTPUT;
    if (outputPath) {
        if (!fs.existsSync(outputPath)) {
            throw new Error(`XLN_DEPLOY_OUTPUT does not exist: ${outputPath}`);
        }
        const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        return {
            depository: output.contracts?.depository,
            account: output.contracts?.account,
        };
    }

    const deploymentFile = "ignition/deployments/chain-31337/deployed_addresses.json";
    if (!fs.existsSync(deploymentFile)) {
        throw new Error(`Deployment file not found: ${deploymentFile}`);
    }
    const deploymentData = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));
    return {
        depository: deploymentData['DepositoryModule#Depository'],
        account: deploymentData['DepositoryModule#Account'],
    };
}

async function main() {
    console.log("🔍 Verifying deployed contract functions...");

    const deploymentData = loadDeploymentData();
    const depositoryAddress = process.env.DEPOSITORY_ADDRESS || deploymentData.depository;

    if (!depositoryAddress) {
        console.log("❌ Depository address not found");
        process.exit(1);
    }

    console.log("📍 Verifying Depository at:", depositoryAddress);

    // Get Account library address for linking
    const accountLibraryAddress = process.env.ACCOUNT_ADDRESS || deploymentData.account;

    if (!accountLibraryAddress) {
        console.log("❌ Account library address not found - needed for Depository linking");
        process.exit(1);
    }
    console.log("📍 Account library at:", accountLibraryAddress);

    // Connect to contract with linked library
    const Depository = await ethers.getContractFactory("Depository", {
        libraries: {
            Account: accountLibraryAddress
        }
    });
    const depository = Depository.attach(depositoryAddress);

    // Check bytecode
    const provider = depository.runner.provider;
    const deployedBytecode = await provider.getCode(depositoryAddress);
    console.log("🔍 Contract bytecode length:", deployedBytecode.length, "characters");
    if (deployedBytecode === "0x") {
        throw new Error(`No deployed bytecode at ${depositoryAddress}`);
    }

    // Get actual function selectors from contract interface
    console.log("🔍 Getting contract factory...");
    const DepositoryFactory = await ethers.getContractFactory("Depository", {
        libraries: {
            Account: accountLibraryAddress
        }
    });
    console.log("🔍 Contract factory:", DepositoryFactory ? "✅ LOADED" : "❌ NULL");

    if (!DepositoryFactory) {
        console.log("❌ Contract factory is null - compilation issue");
        process.exit(1);
    }

    const contractInterface = DepositoryFactory.interface;
    console.log("🔍 Contract interface:", contractInterface ? "✅ LOADED" : "❌ NULL");

    if (!contractInterface) {
        console.log("❌ Contract interface is null - ABI issue");
        process.exit(1);
    }

    console.log("🔍 Interface properties:", Object.keys(contractInterface));
    console.log("🔍 Interface.functions exists:", !!contractInterface.functions);
    console.log("🔍 Interface.fragments exists:", !!contractInterface.fragments);

    if (!contractInterface.functions) {
        console.log("❌ Interface.functions is missing, checking fragments...");

        if (contractInterface.fragments) {
            console.log("🔍 Using fragments instead of functions");
            const functionFragments = contractInterface.fragments.filter(f => f.type === 'function');
            console.log("📋 Function fragments:", functionFragments.map(f => f.name));
        } else {
            console.log("❌ No functions or fragments available");
            process.exit(1);
        }
    }

    console.log("🔍 Calculating ACTUAL function selectors from interface...");

    // Use fragments since modern ethers doesn't expose functions directly
    const functionFragments = contractInterface.fragments.filter(f => f.type === 'function');
    const functionNames = functionFragments.map(f => f.name);
    console.log("📋 Available functions in interface:", functionNames);

    // Check if critical functions exist
    const hasProcessBatch = functionNames.includes('processBatch');
    const hasWatchtowerCounterDispute = functionNames.includes('watchtowerCounterDispute');

    console.log("🔍 Critical function availability:");
    console.log("   processBatch:", hasProcessBatch ? "✅ FOUND" : "❌ MISSING");
    console.log(
        "   watchtowerCounterDispute:",
        hasWatchtowerCounterDispute ? "✅ FOUND" : "❌ MISSING",
    );
    if (!hasProcessBatch || !hasWatchtowerCounterDispute) {
        console.log("❌ CRITICAL: Essential functions missing from contract interface!");
        process.exit(1);
    }

    // Calculate correct selectors
    const processBatchFrag = contractInterface.getFunction("processBatch");
    const watchtowerCounterDisputeFrag = contractInterface.getFunction("watchtowerCounterDispute");
    const actualProcessBatchSelector = processBatchFrag.selector;
    const actualWatchtowerCounterDisputeSelector = watchtowerCounterDisputeFrag.selector;

    console.log("🔍 ACTUAL function selectors:");
    console.log("   processBatch:", actualProcessBatchSelector);
    console.log("   watchtowerCounterDispute:", actualWatchtowerCounterDisputeSelector);
    console.log("🔍 Checking ACTUAL selectors in deployed bytecode...");
    const processBatchFound = deployedBytecode.includes(actualProcessBatchSelector.slice(2));
    const watchtowerCounterDisputeFound = deployedBytecode.includes(actualWatchtowerCounterDisputeSelector.slice(2));
    console.log("   processBatch:", processBatchFound ? "✅ FOUND" : "❌ MISSING");
    console.log(
        "   watchtowerCounterDispute:",
        watchtowerCounterDisputeFound ? "✅ FOUND" : "❌ MISSING",
    );

    // FAIL if any critical function is missing
    if (!processBatchFound || !watchtowerCounterDisputeFound) {
        console.log("❌ CRITICAL: Essential functions missing from deployed contract!");
        process.exit(1);
    }

    // Skip the problematic interface test since we already verified functions exist
    console.log("💡 Skipping interface test - functions already verified via fragments");

    console.log("✅ ALL CRITICAL FUNCTIONS VERIFIED IN DEPLOYED CONTRACT!");
    console.log("✅ Contract verification complete - deployment successful!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Verification failed:", error);
        process.exit(1);
    });
