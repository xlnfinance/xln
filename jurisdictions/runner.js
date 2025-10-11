#!/usr/bin/env node
import 'ts-node/register';
import { HardhatUserConfig } from 'hardhat/types';
import { run, compile } from 'hardhat';

const config = {
  solidity: "0.8.24",
  typechain: {
    outDir: "typechain",
    target: "ethers-v6",
  },
};

export default config;

// Run Hardhat tasks
run();