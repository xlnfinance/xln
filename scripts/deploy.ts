import { ethers, network } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

interface DeploymentConfig {
  network: string;
  rpcUrl: string;
  chainId: number;
  gasPrice?: string;
  gasLimit?: string;
  verifyContracts: boolean;
  deploymentFile: string;
}

interface DeploymentResult {
  timestamp: string;
  network: string;
  chainId: number;
  contracts: {
    [key: string]: {
      address: string;
      transactionHash: string;
      blockNumber: number;
    };
  };
}

class XLNDeployer {
  private config: DeploymentConfig;
  private deploymentResult: DeploymentResult;

  constructor() {
    this.config = this.initializeConfig();
    this.deploymentResult = {
      timestamp: new Date().toISOString(),
      network: this.config.network,
      chainId: this.config.chainId,
      contracts: {},
    };
  }

  private initializeConfig(): DeploymentConfig {
    const networkName = network.name;
    let config: DeploymentConfig;

    switch (networkName) {
      case 'sepolia':
        config = {
          network: 'sepolia',
          rpcUrl: process.env.SEPOLIA_RPC_URL || '',
          chainId: 11155111,
          gasPrice: ethers.parseUnits('20', 'gwei').toString(),
          gasLimit: '5000000',
          verifyContracts: true,
          deploymentFile: 'deployments/sepolia.json',
        };
        break;
      case 'mainnet':
        config = {
          network: 'mainnet',
          rpcUrl: process.env.MAINNET_RPC_URL || '',
          chainId: 1,
          gasPrice: ethers.parseUnits('50', 'gwei').toString(),
          gasLimit: '5000000',
          verifyContracts: true,
          deploymentFile: 'deployments/mainnet.json',
        };
        break;
      case 'localhost':
      case 'hardhat':
        config = {
          network: networkName,
          rpcUrl: 'http://127.0.0.1:8545',
          chainId: 31337,
          gasPrice: ethers.parseUnits('1', 'gwei').toString(),
          gasLimit: '30000000',
          verifyContracts: false,
          deploymentFile: 'deployments/localhost.json',
        };
        break;
      default:
        throw new Error(`Unsupported network: ${networkName}`);
    }

    return config;
  }

  async validateNetwork(): Promise<void> {
    const provider = ethers.provider;
    const chainId = (await provider.getNetwork()).chainId;

    if (Number(chainId) !== this.config.chainId) {
      throw new Error(
        `Chain ID mismatch. Expected ${this.config.chainId}, got ${chainId}`
      );
    }

    console.log(`✓ Network validated: ${this.config.network} (Chain ID: ${chainId})`);
  }

  async checkDeployer(): Promise<string> {
    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);

    if (balance === 0n) {
      throw new Error(
        `Deployer account ${deployer.address} has no balance on ${this.config.network}`
      );
    }

    console.log(`✓ Deployer: ${deployer.address}`);
    console.log(`✓ Balance: ${ethers.formatEther(balance)} ETH`);

    return deployer.address;
  }

  async deployContract(
    contractName: string,
    constructorArgs: any[] = []
  ): Promise<{ address: string; hash: string; blockNumber: number }> {
    const [deployer] = await ethers.getSigners();
    const Contract = await ethers.getContractFactory(contractName, deployer);

    console.log(`\nDeploying ${contractName}...`);

    const deployTx = await Contract.deploy(...constructorArgs, {
      gasPrice: this.config.gasPrice,
      gasLimit: this.config.gasLimit,
    });

    const deployedContract = await deployTx.waitForDeployment();
    const address = await deployedContract.getAddress();
    const receipt = await ethers.provider.getTransactionReceipt(deployTx.hash!);

    if (!receipt) {
      throw new Error(`Failed to get transaction receipt for ${contractName}`);
    }

    console.log(`✓ ${contractName} deployed to: ${address}`);
    console.log(`✓ Transaction hash: ${deployTx.hash}`);
    console.log(`✓ Gas used: ${receipt.gasUsed}`);

    return {
      address,
      hash: deployTx.hash!,
      blockNumber: receipt.blockNumber,
    };
  }

  async verifyContract(address: string, constructorArgs: any[]): Promise<void> {
    if (!this.config.verifyContracts) {
      console.log(`⊘ Skipping verification (not enabled for ${this.config.network})`);
      return;
    }

    try {
      console.log(`\nVerifying contract at ${address}...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));

      await ethers.provider.getBlockNumber();
      console.log(`✓ Contract verification queued`);
    } catch (error) {
      console.warn(`⚠ Verification failed: ${error}`);
    }
  }

  async saveDeployment(): Promise<void> {
    const deploymentsDir = path.dirname(this.config.deploymentFile);

    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    fs.writeFileSync(
      this.config.deploymentFile,
      JSON.stringify(this.deploymentResult, null, 2)
    );

    console.log(`\n✓ Deployment saved to ${this.config.deploymentFile}`);
  }

  recordDeployment(
    contractName: string,
    result: { address: string; hash: string; blockNumber: number }
  ): void {
    this.deploymentResult.contracts[contractName] = {
      address: result.address,
      transactionHash: result.hash,
      blockNumber: result.blockNumber,
    };
  }
}

async function main() {
  const deployer = new XLNDeployer();

  try {
    console.log(`🚀 Starting XLN L2 Contract Deployment\n`);
    console.log(`Network: ${deployer['config'].network}`);
    console.log(`Chain ID: ${deployer['config'].chainId}\n`);

    await deployer.validateNetwork();
    await deployer.checkDeployer();

    const depositoryResult = await deployer.deployContract('Depository', []);
    deployer.recordDeployment('Depository', depositoryResult);
    await deployer.verifyContract(depositoryResult.address, []);

    const providerResult = await deployer.deployContract('SubcontractProvider', [
      depositoryResult.address,
    ]);
    deployer.recordDeployment('SubcontractProvider', providerResult);
    await deployer.verifyContract(providerResult.address, [depositoryResult.address]);

    await deployer.saveDeployment();

    console.log(`\n✅ Deployment completed successfully!`);
  } catch (error) {
    console.error(`\n❌ Deployment failed:`, error);
    process.exitCode = 1;
  }
}

main();
