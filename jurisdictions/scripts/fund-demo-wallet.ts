#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Contract,
  HDNodeWallet,
  JsonRpcProvider,
  MaxUint256,
  Mnemonic,
  Wallet,
  getIndexedAccountPath,
  parseEther,
  parseUnits,
} from 'ethers';

import { generateLazyEntityId } from '../../runtime/entity/factory';
import { prepareSignedBatch } from '../../runtime/hanko/batch';
import { createEmptyBatch } from '../../runtime/jurisdiction/batch';
import { deriveJurisdictionSignerIndex } from '../../runtime/jurisdiction/signer-derivation';
import { Depository__factory } from '../typechain-types/factories/contracts/Depository.sol/Depository__factory';

type PublicJurisdiction = Readonly<{
  name: string;
  chainId: number;
  rpc: string;
  contracts: Readonly<{ depository: string }>;
  tokens: Readonly<{ USDT: Readonly<{ address: string; tokenId: number; decimals: number }> }>;
}>;

const argument = (name: string): string | undefined => {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const deployerPrivateKey = String(process.env['PUBLIC_CHAIN_PRIVATE_KEY'] || '').trim();
const mnemonicPhrase = String(process.env['XLN_DEMO_WALLET_MNEMONIC'] || '').trim();
const jurisdictionId = argument('--jurisdiction') || 'ethereum-sepolia';
const displayAmount = argument('--amount') || '100000';
const gasFunding = argument('--gas-funding') || '0.001';

if (!/^0x[0-9a-f]{64}$/i.test(deployerPrivateKey)) {
  throw new Error('PUBLIC_CHAIN_PRIVATE_KEY_REQUIRED');
}
if (!mnemonicPhrase) throw new Error('XLN_DEMO_WALLET_MNEMONIC_REQUIRED');

const allJurisdictions = JSON.parse(
  readFileSync(resolve(process.cwd(), 'jurisdictions/jurisdictions.json'), 'utf8'),
) as { jurisdictions?: Record<string, PublicJurisdiction> };
const jurisdiction = allJurisdictions.jurisdictions?.[jurisdictionId];
if (!jurisdiction) throw new Error(`DEMO_WALLET_JURISDICTION_UNKNOWN:${jurisdictionId}`);

const mnemonic = Mnemonic.fromPhrase(mnemonicPhrase);
const derivationIndex = deriveJurisdictionSignerIndex(jurisdiction.name);
const signer = HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(derivationIndex));
const entityId = generateLazyEntityId([signer.address], 1n);
const provider = new JsonRpcProvider(jurisdiction.rpc);
const deployer = new Wallet(deployerPrivateKey, provider);
const depository = Depository__factory.connect(jurisdiction.contracts.depository, deployer);
const stablecoin = new Contract(
  jurisdiction.tokens.USDT.address,
  [
    'function approve(address spender,uint256 amount) returns (bool)',
    'function allowance(address owner,address spender) view returns (uint256)',
  ],
  deployer,
);
const units = parseUnits(displayAmount, jurisdiction.tokens.USDT.decimals);
const gasUnits = parseEther(gasFunding);
const foundationEntityId = `0x${'0'.repeat(63)}1`;

const network = await provider.getNetwork();
if (network.chainId !== BigInt(jurisdiction.chainId)) {
  throw new Error(`DEMO_WALLET_CHAIN_ID_MISMATCH:${network.chainId}:${jurisdiction.chainId}`);
}

// Prove the newly derived lazy Entity can authorize this exact Depository before
// spending any ETH or moving tokens. A malformed derivation would fail here.
const signerNonce = await depository.entityNonces(entityId);
const signerProof = prepareSignedBatch(
  createEmptyBatch(),
  entityId,
  signer.privateKey,
  BigInt(jurisdiction.chainId),
  jurisdiction.contracts.depository,
  signerNonce,
);
await depository.processBatch.staticCall(
  signerProof.encodedBatch,
  signerProof.hankoData,
  signerProof.nextNonce,
);

const allowance = await stablecoin.allowance(deployer.address, jurisdiction.contracts.depository) as bigint;
if (allowance < units) {
  const approval = await stablecoin.approve(jurisdiction.contracts.depository, MaxUint256);
  const receipt = await approval.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`DEMO_WALLET_APPROVAL_FAILED:${approval.hash}`);
}

const existingReserve = await depository._reserves(entityId, jurisdiction.tokens.USDT.tokenId);
let reserveFundingTx: string | null = null;
if (existingReserve < units) {
  const batch = createEmptyBatch();
  batch.externalTokenToReserve.push({
    entity: entityId,
    contractAddress: jurisdiction.tokens.USDT.address,
    externalTokenId: 0n,
    tokenType: 0,
    internalTokenId: jurisdiction.tokens.USDT.tokenId,
    amount: units - existingReserve,
  });
  const nonce = await depository.entityNonces(foundationEntityId);
  const signed = prepareSignedBatch(
    batch,
    foundationEntityId,
    deployerPrivateKey,
    BigInt(jurisdiction.chainId),
    jurisdiction.contracts.depository,
    nonce,
  );
  await depository.processBatch.staticCall(
    signed.encodedBatch,
    signed.hankoData,
    signed.nextNonce,
  );
  const transaction = await depository.processBatch(
    signed.encodedBatch,
    signed.hankoData,
    signed.nextNonce,
  );
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`DEMO_WALLET_RESERVE_FUNDING_FAILED:${transaction.hash}`);
  reserveFundingTx = transaction.hash;
}

const existingGas = await provider.getBalance(signer.address);
let gasFundingTx: string | null = null;
if (existingGas < gasUnits) {
  const transaction = await deployer.sendTransaction({ to: signer.address, value: gasUnits - existingGas });
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`DEMO_WALLET_GAS_FUNDING_FAILED:${transaction.hash}`);
  gasFundingTx = transaction.hash;
}

const finalReserve = await depository._reserves(entityId, jurisdiction.tokens.USDT.tokenId);
console.log(JSON.stringify({
  jurisdiction: jurisdiction.name,
  chainId: jurisdiction.chainId,
  derivationIndex,
  signerAddress: signer.address,
  entityId,
  reserveRaw: finalReserve.toString(),
  reserveDisplay: displayAmount,
  gasWei: (await provider.getBalance(signer.address)).toString(),
  gasFundingTx,
  reserveFundingTx,
}));
