import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createVM } from '@ethereumjs/vm';
import { ethers } from 'ethers';
import { safeStringify } from '../../../../protocol/serialization';
import solc from 'solc';
import { decodeDisputeProofBodyEvidenceCalldata, recoverDisputeProofBody } from '../../../../jurisdiction/adapter/rpc-public';
import { DisputeCalldata } from '../../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-calldata';
import { PROOF_BODY_ABI } from '../../../../protocol/dispute/proof-body';
import { argsFor, body, startCall } from '../../../helpers/jurisdiction/dispute-calldata-fixtures';
import { layouts } from './layouts';

// Import production structs; do not duplicate their tuple schemas in an oracle.
const source = `pragma solidity ^0.8.37;
import "Types.sol";
contract Decoder {
  function processBatch(bytes calldata encodedBatch, bytes calldata hanko, uint256 nonce) external pure returns(bytes32) {
    Batch memory batch = abi.decode(encodedBatch, (Batch));
    // Force both external bytes arguments and every decoded Batch field through solc's decoder.
    bytes memory decoded = abi.encode(batch, hanko, nonce);
    require(decoded.length > 0);
    if (batch.disputeStarts.length > 0) return keccak256(abi.encode(batch.disputeStarts[0].initialProofbody));
    if (batch.counterDisputes.length > 0) return keccak256(abi.encode(batch.counterDisputes[0].counterProofbody));
    return keccak256(abi.encode(batch.disputeFinalizations[0].finalProofbody));
  }
  function watchtowerCounterDispute(bytes32 entityId, FinalDisputeProof calldata params,
    uint256 window, uint256 sequence, bytes calldata ownerHanko) external pure returns(bytes32) {
    // Depository's finalization copies calldata params to memory before clearing sig.
    bytes memory decoded = abi.encode(entityId, params, window, sequence, ownerHanko);
    require(decoded.length > 0);
    return keccak256(abi.encode(params.finalProofbody));
  }
}`;
const compile = (): Uint8Array => {
  const output = JSON.parse(solc.compile(safeStringify({ language: 'Solidity', sources: { 'Decoder.sol': { content: source } },
    settings: { viaIR: true, optimizer: { enabled: true, runs: 1 }, evmVersion: 'osaka',
      outputSelection: { '*': { '*': ['evm.bytecode.object', 'irOptimized'] } } },
  }), { import: path => ({ contents: readFileSync(new URL(`../../../../../jurisdictions/contracts/${path}`, import.meta.url), 'utf8') }) }));
  for (const error of output.errors ?? []) if (error.severity === 'error') throw new Error(error.formattedMessage);
  return ethers.getBytes(`0x${output.contracts['Decoder.sol'].Decoder.evm.bytecode.object}`);
};

test('I7: 2,400 seeded direct layouts agree with the deployed solc ABI decoder', async () => {
  const started = performance.now();
  const vm = await createVM();
  const deployment = await vm.evm.runCall({ data: compile(), gasLimit: 30_000_000n });
  if (deployment.execResult.exceptionError) throw deployment.execResult.exceptionError;
  const address = deployment.createdAddress;
  if (!address) throw new Error('DECODER_DEPLOYMENT_MISSING');
  const execute = async (data: string): Promise<string | null> => {
    const result = await vm.evm.runCall({ to: address, data: ethers.getBytes(data), gasLimit: 10_000_000n });
    return result.execResult.exceptionError ? null : ethers.hexlify(result.execResult.returnValue);
  };
  expect(await execute(startCall())).toBe(argsFor(body).proofbodyHash); // Known-answer oracle smoke.
  const corpus = layouts(2400);
  let accepted = 0; let rejected = 0;
  const mismatches: string[] = [];
  for (const [index, data] of corpus.entries()) {
    const expected = await execute(data);
    let actual: string | null = null;
    try {
      const raw = new DisputeCalldata(data);
      const direct = raw.directCallData();
      const candidates = direct === null ? [] : decodeDisputeProofBodyEvidenceCalldata(direct);
      const first = candidates[0];
      if (first) {
        actual = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_ABI], [first.proofbody]));
        if (expected !== null) {
          const event = { ...first, proofbodyHash: expected, finalProofbodyHash: expected };
          const recovered = recoverDisputeProofBody(raw, first.eventName, event);
          actual = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_ABI], [recovered]));
        }
      }
    } catch { actual = null; } // A decoder rejection is compared with the independently executed EVM result.
    if (expected === null) rejected += 1; else accepted += 1;
    if (actual !== expected) mismatches.push(`${index}:kind=${index % 24}:evm=${expected}:watcher=${actual}`);
  }
  console.info(`solc=${solc.version()} seed=0x51c0dec fuzz=${corpus.length} accepted=${accepted} rejected=${rejected} mismatches=${mismatches.length} elapsedMs=${(performance.now() - started).toFixed(0)}`);
  expect(accepted).toBeGreaterThan(0); expect(rejected).toBeGreaterThan(0);
  expect(mismatches).toEqual([]);
  expect(performance.now() - started).toBeLessThan(30_000);
}, 30_000);
