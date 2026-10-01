import { expect } from 'chai';
import hre from 'hardhat';

const EIP_170_MAX_DEPLOYED_BYTES = 24_576;
const productionContracts = ['Account', 'Depository', 'EntityProvider'] as const;

describe('EIP-170 production contract sizes', function () {
  for (const contractName of productionContracts) {
    it(`${contractName} deployed bytecode stays within 24,576 bytes`, async function () {
      const artifact = await hre.artifacts.readArtifact(contractName);
      const deployedBytes = (artifact.deployedBytecode.length - 2) / 2;
      expect(
        deployedBytes,
        `${contractName} deployed bytecode ${deployedBytes} exceeds EIP-170 limit ${EIP_170_MAX_DEPLOYED_BYTES}`,
      ).to.be.at.most(EIP_170_MAX_DEPLOYED_BYTES);
    });
  }
});
