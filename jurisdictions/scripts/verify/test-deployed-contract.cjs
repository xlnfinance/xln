const hre = require("hardhat");
const fs = require("node:fs");

function readDeployOutput() {
    const outputPath = process.env.XLN_DEPLOY_OUTPUT;
    if (!outputPath) return {};
    if (!fs.existsSync(outputPath)) {
        throw new Error(`XLN_DEPLOY_OUTPUT does not exist: ${outputPath}`);
    }
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
}

async function main() {
    const deployOutput = readDeployOutput();
    const contractAddress = process.env.DEPOSITORY_ADDRESS || deployOutput.contracts?.depository;
    if (!contractAddress) {
        throw new Error("DEPOSITORY_ADDRESS or XLN_DEPLOY_OUTPUT.contracts.depository is required");
    }
    console.log("🔍 Testing deployed contract at:", contractAddress);

    try {
        const code = await hre.ethers.provider.getCode(contractAddress);
        if (code === "0x") {
            throw new Error(`No deployed bytecode at ${contractAddress}`);
        }
        console.log(`✅ Bytecode present (${code.length} chars)`);

        const contract = await hre.ethers.getContractAt('Depository', contractAddress);
        console.log("✅ Contract attached successfully");

        const functions = contract.interface.fragments
            .filter(fragment => fragment.type === "function")
            .map(fragment => fragment.name);

        const required = ["processBatch", "watchtowerCounterDispute", "_reserves"];
        const forbidden = ["debugBulkFundEntities"];

        for (const name of required) {
            if (!functions.includes(name)) throw new Error(`Missing required function: ${name}`);
            console.log(`✅ ${name} present`);
        }

        for (const name of forbidden) {
            if (functions.includes(name)) throw new Error(`Forbidden stale function present: ${name}`);
            console.log(`✅ ${name} absent`);
        }

    } catch (error) {
        console.error("❌ Contract test failed:", error);
        process.exit(1);
    }
}

main().catch(console.error);
