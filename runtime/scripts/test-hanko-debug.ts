/**
 * Minimal test to debug Hanko board hash mismatch
 * Runs directly without full scenario infrastructure
 */

import { BrowserVMProvider } from '../browservm.js';
import { ethers } from 'ethers';
import { getSignerPrivateKey, registerSeededKeys } from '../account-crypto.js';
import { isLeftEntity } from '../entity-id-utils';

async function main() {
  console.log('🔍 Testing Hanko Board Hash Computation\n');

  const runtimeSeed = process.env.XLN_RUNTIME_SEED ?? process.env.RUNTIME_SEED;
  if (runtimeSeed === undefined || runtimeSeed === null) {
    throw new Error('XLN_RUNTIME_SEED missing - unlock vault or set XLN_RUNTIME_SEED');
  }

  // Register signer keys from runtime seed
  await registerSeededKeys(runtimeSeed, ['1', '2', '3', '4', '5', '6', '7', '8']);
  console.log('✅ Registered signer keys\n');

  // Create BrowserVM
  const browserVM = new BrowserVMProvider();
  await browserVM.init();

  console.log('✅ BrowserVM initialized');
  console.log(`   EntityProvider: ${browserVM.getEntityProviderAddress()}`);
  console.log(`   Depository: ${browserVM.getDepositoryAddress()}\n`);

  // Register entities with signers 2, 3, 4
  console.log('📝 Registering entities...\n');
  const signerIds = ['2', '3', '4'];
  const entityNumbers = await browserVM.registerEntitiesWithSigners(signerIds);
  console.log(`   Registered entities: ${JSON.stringify(entityNumbers)}\n`);

  // Get entity info
  for (let i = 0; i < entityNumbers.length; i++) {
    const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[i]), 32);
    const info = await browserVM.getEntityInfo(entityId);
    console.log(`   Entity ${entityNumbers[i]} (${signerIds[i]}): boardHash=${info.currentBoardHash.slice(0, 18)}...`);
  }
  console.log();

  // Now test signing a settlement
  console.log('📝 Testing settlement signature...\n');

  const leftEntity = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[0]), 32); // Entity 2
  const rightEntity = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[1]), 32); // Entity 3

  console.log(`   Left: ${leftEntity.slice(0, 18)}... (Entity ${entityNumbers[0]})`);
  console.log(`   Right: ${rightEntity.slice(0, 18)}... (Entity ${entityNumbers[1]})\n`);

  // Create test settlement diffs
  // Conservation: leftDiff + rightDiff + collateralDiff = 0
  // Move from left reserves to collateral
  const diffs = [{
    tokenId: 1,
    leftDiff: -1000n,           // Left gives up 1000 from reserves
    rightDiff: 0n,              // Right doesn't change
    collateralDiff: 1000n,      // Goes to collateral
    ondeltaDiff: 0n
  }];

  // Sign settlement (this creates Hanko for numbered entities)
  console.log('🔐 Signing settlement...');
  try {
    const sig = await browserVM.signSettlement(leftEntity, rightEntity, diffs, [], []);
    console.log(`   Signature length: ${sig.length} chars (${(sig.length - 2) / 2} bytes)`);
    console.log(`   Signature type: ${sig.length === 132 ? 'ECDSA (65 bytes)' : 'Hanko'}`);
    console.log(`   Signature prefix: ${sig.slice(0, 50)}...\n`);

    // Debug: decode the Hanko and show what we're sending
    console.log('🔍 Debugging Hanko structure...');
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    // Decode WITH outer tuple wrapper (matches Solidity abi.decode(data, (HankoBytes)))
    const decoded = abiCoder.decode(
      ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
      sig
    );
    const [placeholders, packedSigs, claims] = decoded[0];
    console.log(`   Placeholders: ${placeholders.length}`);
    // packedSigs is a hex string, so length/2-1 = byte count
    const packedSigBytes = typeof packedSigs === 'string' ? (packedSigs.length - 2) / 2 : packedSigs.length;
    console.log(`   PackedSigs length: ${packedSigBytes} bytes (raw: ${packedSigs.length})`);
    console.log(`   Claims: ${claims.length}`);
    if (claims.length > 0) {
      const claim = claims[0];
      console.log(`   Claim[0]:`);
      console.log(`     entityId: ${claim[0]}`);
      console.log(`     entityIndexes: [${claim[1].join(', ')}]`);
      console.log(`     weights: [${claim[2].join(', ')}]`);
      console.log(`     threshold: ${claim[3]}`);
    }

    // Verify channel key matches between TS and Solidity
    console.log('\n🔍 Channel key verification...');
    {
      // Get channelKey from contract
      const depInterface = new ethers.Interface([
        'function accountKey(bytes32 e1, bytes32 e2) pure returns (bytes)'
      ]);
      const callData = depInterface.encodeFunctionData('accountKey', [leftEntity, rightEntity]);
      const result = await browserVM.executeTx({
        to: browserVM.getDepositoryAddress(),
        data: callData,
        gasLimit: 100000n,
        value: 0n
      });
      // Note: executeTx might not return the result properly for view calls
      // Let's use my getChannelKey and compare

      // My TypeScript channelKey
      const isLeft = isLeftEntity(leftEntity, rightEntity);
      const tsLeft = isLeft ? leftEntity : rightEntity;
      const tsRight = isLeft ? rightEntity : leftEntity;
      const tsChannelKey = ethers.solidityPacked(['bytes32', 'bytes32'], [tsLeft, tsRight]);

      console.log(`   leftEntity:  ${leftEntity}`);
      console.log(`   rightEntity: ${rightEntity}`);
      console.log(`   TS channelKey: ${tsChannelKey.slice(0, 50)}... (${(tsChannelKey.length - 2) / 2} bytes)`);
    }

    // Verify board hash computation matches
    console.log('\n🔍 Board hash verification...');
    {
      // What was registered (from browserVM.registerEntitiesWithSigners)
      const { getCachedSignerPrivateKey } = await import('../account-crypto.js');
      const privKey = getCachedSignerPrivateKey('3')!;
      const wallet = new ethers.Wallet(ethers.hexlify(privKey));
      const validatorAddress = wallet.address;
      const validatorEntityId = ethers.zeroPadValue(validatorAddress, 32);

      // Compute board hash the way registration does it
      const registrationBoardHash = ethers.keccak256(abiCoder.encode(
        ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
        [[1n, [validatorEntityId], [1n], 0n, 0n, 0n]]
      ));
      console.log(`   Registration board hash: ${registrationBoardHash}`);
      console.log(`   Validator address: ${validatorAddress}`);
      console.log(`   Validator entityId in board: ${validatorEntityId}`);

      // What verification computes (from _buildBoardHash)
      // It builds: Board { threshold, [recoveredAddress padded to bytes32], [weight], 0, 0, 0 }
      // recoveredAddress is from signature recovery
      const verificationBoardHash = ethers.keccak256(abiCoder.encode(
        ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
        [[1n, [validatorEntityId], [1n], 0n, 0n, 0n]]
      ));
      console.log(`   Verification board hash: ${verificationBoardHash}`);
      console.log(`   Match: ${registrationBoardHash === verificationBoardHash}`);

      // Get stored board hash from chain
      const storedInfo = await browserVM.getEntityInfo(rightEntity);
      console.log(`   Stored board hash:       ${storedInfo.currentBoardHash}`);
      console.log(`   Stored matches expected: ${storedInfo.currentBoardHash === registrationBoardHash}`);
    }

    // Direct test: Call verifyHankoSignature on EntityProvider
    console.log('\n📝 Direct verifyHankoSignature test...');
    const testHash = ethers.keccak256(ethers.toUtf8Bytes('test'));
    try {
      // We need to sign this hash with the same signer
      const privateKey = (await import('../account-crypto.js')).getCachedSignerPrivateKey('3');
      const wallet = new ethers.Wallet(ethers.hexlify(privateKey!));
      const hashBytes = ethers.getBytes(testHash);
      const signature = wallet.signingKey.sign(hashBytes);
      // Pack in Hanko format: RS bytes + V bit (0 for v=27, 1 for v=28)
      const vBit = signature.v === 28 ? 1 : 0;
      const packedTestSig = ethers.concat([signature.r, signature.s, ethers.toBeHex(vBit, 1)]);

      // Test BOTH encodings to see which Solidity expects
      // Version A: No outer tuple wrapper (current)
      const testHankoNoWrapper = abiCoder.encode(
        ['bytes32[]', 'bytes', 'tuple(bytes32,uint256[],uint256[],uint256)[]'],
        [
          [], // placeholders
          packedTestSig, // 65 bytes
          [[
            rightEntity, // entityId (Entity 3)
            [0], // index 0 = the signature
            [1], // weight 1
            1, // threshold 1
          ]]
        ]
      );

      // Version B: With outer tuple wrapper
      const testHankoWithWrapper = abiCoder.encode(
        ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
        [[
          [], // placeholders
          packedTestSig, // 65 bytes
          [[
            rightEntity, // entityId (Entity 3)
            [0], // index 0 = the signature
            [1], // weight 1
            1, // threshold 1
          ]]
        ]]
      );

      console.log(`   Encoding A (no wrapper): ${(testHankoNoWrapper.length - 2) / 2} bytes, starts with ${testHankoNoWrapper.slice(0, 10)}`);
      console.log(`   Encoding B (with wrapper): ${(testHankoWithWrapper.length - 2) / 2} bytes, starts with ${testHankoWithWrapper.slice(0, 10)}`);

      const testHanko = testHankoNoWrapper; // Use version A for structure printout
      console.log(`   Test hanko length: ${(testHanko.length - 2) / 2} bytes`);
      console.log(`   Test hanko structure (576 bytes):`);
      // Helper to get word at byte offset
      const getWord = (offset: number) => testHanko.slice(2 + offset*2, 2 + offset*2 + 64);
      console.log(`     [0x00] offset to placeholders: ${getWord(0)}`);
      console.log(`     [0x20] offset to packedSigs:   ${getWord(32)}`);
      console.log(`     [0x40] offset to claims:       ${getWord(64)}`);
      console.log(`     [0x60] placeholders.length:    ${getWord(96)}`);
      console.log(`     [0x80] packedSigs.length:      ${getWord(128)}`);
      console.log(`     [0xa0] packedSigs data start:  ${getWord(160)}`);
      // 65 bytes of sig = 3 words starting at 0xa0
      console.log(`     [0x100] claims.length:         ${getWord(256)}`);
      console.log(`     [0x120] claim[0] offset:       ${getWord(288)}`);
      console.log(`     [0x140] claim[0].entityId:     ${getWord(320)}`);
      console.log(`     [0x160] claim[0] entityIdxOff: ${getWord(352)}`);
      console.log(`     [0x180] claim[0] weightsOff:   ${getWord(384)}`);
      console.log(`     [0x1a0] claim[0].threshold:    ${getWord(416)}`)

      // Test BOTH versions via runCall
      const epInterface = new ethers.Interface([
        'function verifyHankoSignature(bytes hankoData, bytes32 hash) external returns (bytes32 entityId, bool success)'
      ]);

      for (const [name, hankoData] of [['A (no wrapper)', testHankoNoWrapper], ['B (with wrapper)', testHankoWithWrapper]] as const) {
        console.log(`\n   Testing ${name}...`);
        const callData = epInterface.encodeFunctionData('verifyHankoSignature', [hankoData, testHash]);

        // Use raw runCall to get actual return value / revert reason
        const rawResult = await (browserVM as any).vm.evm.runCall({
          to: (browserVM as any).entityProviderAddress,
          caller: (browserVM as any).deployerAddress,
          data: ethers.getBytes(callData),
          gasLimit: 500000n,
        });

        if (rawResult.execResult.exceptionError) {
          console.log(`   REVERTED: ${rawResult.execResult.exceptionError.error}`);
          const returnValue = rawResult.execResult.returnValue;
          if (returnValue.length > 0) {
            const returnHex = ethers.hexlify(returnValue);
            // Try to decode as Error(string)
            if (returnHex.startsWith('0x08c379a0')) {
              try {
                const errorMsg = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + returnHex.slice(10));
                console.log(`   Error: ${errorMsg[0]}`);
              } catch {}
            }
            // Try to decode as Panic(uint256)
            if (returnHex.startsWith('0x4e487b71')) {
              const panicCode = BigInt('0x' + returnHex.slice(10, 74));
              console.log(`   Panic code: ${panicCode}`);
            }
          }
        } else {
          console.log(`   SUCCEEDED!`);
          const decoded = epInterface.decodeFunctionResult('verifyHankoSignature', rawResult.execResult.returnValue);
          console.log(`   Result: entityId=${decoded[0]}, success=${decoded[1]}`);
        }
      }
    } catch (e: any) {
      console.log(`   Direct test error: ${e.message}`);
    }

    // Direct test with the ACTUAL settlement hash and Hanko sig
    console.log('\n📝 Direct test with settlement hash and sig...');
    try {
      const abiCoder2 = ethers.AbiCoder.defaultAbiCoder();

      // Compute the same hash that signSettlement computed
      const channelKey2 = ethers.solidityPacked(['bytes32', 'bytes32'], [leftEntity, rightEntity]);
      const accountInfo2 = await browserVM.getAccountInfo(leftEntity, rightEntity);
      const encodedMsg2 = abiCoder2.encode(
        ['uint256', 'bytes', 'uint256', 'tuple(uint256,int256,int256,int256,int256)[]', 'uint256[]', 'tuple(bytes32,bytes32,uint256,uint256,uint256)[]'],
        [0, channelKey2, accountInfo2.cooperativeNonce, diffs.map(d => [d.tokenId, d.leftDiff, d.rightDiff, d.collateralDiff, d.ondeltaDiff]), [], []]
      );
      const settlementHash = ethers.keccak256(encodedMsg2);
      console.log(`   Settlement hash: ${settlementHash}`);
      console.log(`   sig length: ${(sig.length - 2) / 2} bytes`);
      console.log(`   sig starts with: ${sig.slice(0, 20)}`);

      // Direct call to EntityProvider via runCall to see full result
      const epInterface2 = new ethers.Interface([
        'function verifyHankoSignature(bytes hankoData, bytes32 hash) external returns (bytes32 entityId, bool success)'
      ]);
      const callData2 = epInterface2.encodeFunctionData('verifyHankoSignature', [sig, settlementHash]);

      const rawResult2 = await (browserVM as any).vm.evm.runCall({
        to: (browserVM as any).entityProviderAddress,
        caller: (browserVM as any).deployerAddress,
        data: ethers.getBytes(callData2),
        gasLimit: 30000000n,
      });

      if (rawResult2.execResult.exceptionError) {
        console.log(`   Settlement sig REVERTED: ${rawResult2.execResult.exceptionError.error}`);
        const rv = rawResult2.execResult.returnValue;
        if (rv.length > 0) {
          const rvHex = ethers.hexlify(rv);
          if (rvHex.startsWith('0x08c379a0')) {
            const errMsg = abiCoder2.decode(['string'], '0x' + rvHex.slice(10));
            console.log(`   Error: ${errMsg[0]}`);
          } else if (rvHex.startsWith('0x4e487b71')) {
            const pc = BigInt('0x' + rvHex.slice(10, 74));
            console.log(`   Panic code: ${pc}`);
          }
        }
      } else {
        console.log(`   Settlement sig SUCCEEDED!`);
        const decoded2 = epInterface2.decodeFunctionResult('verifyHankoSignature', rawResult2.execResult.returnValue);
        console.log(`   Result: entityId=${decoded2[0]}, success=${decoded2[1]}`);
      }
    } catch (e: any) {
      console.log(`   Direct settlement test error: ${e.message}`);
    }

    // Skip empty settlement test - it changes nonce which breaks subsequent tests
    console.log('\n📦 Skipping empty settlement test (would change nonce)...');

    // Compare hash computation between TypeScript and Solidity
    console.log('\n🔍 Comparing hash computation...');
    const depInterface = new ethers.Interface([
      'function computeSettlementHash(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256,int256,int256,int256,int256)[] diffs, uint256[] forgiveDebtsInTokenIds, tuple(bytes32,bytes32,uint256,uint256,uint256)[] insuranceRegs) view returns (bytes32 hash, uint256 nonce, uint256 encodedMsgLength)'
    ]);
    const hashCallData = depInterface.encodeFunctionData('computeSettlementHash', [
      leftEntity,
      rightEntity,
      diffs.map(d => [d.tokenId, d.leftDiff, d.rightDiff, d.collateralDiff, d.ondeltaDiff]),
      [],
      [],
    ]);
    const hashResult = await browserVM.executeTx({
      to: browserVM.getDepositoryAddress(),
      data: hashCallData,
      gasLimit: 500000n,
      value: 0n
    });
    // Since executeTx returns txHash not returnValue, we need vm.evm.runCall
    // Let's use a raw call instead
    const rawHashResult = await (browserVM as any).vm.evm.runCall({
      to: (browserVM as any).depositoryAddress,
      caller: (browserVM as any).deployerAddress,
      data: ethers.getBytes(hashCallData),
      gasLimit: 500000n,
    });
    if (!rawHashResult.execResult.exceptionError) {
      const decoded = depInterface.decodeFunctionResult('computeSettlementHash', rawHashResult.execResult.returnValue);
      console.log(`   Solidity hash: ${decoded[0]}`);
      console.log(`   Solidity nonce: ${decoded[1]}`);
      console.log(`   Solidity encodedMsgLength: ${decoded[2]}`);
      console.log(`   TS hash (from sig): ${sig ? 'check signSettlement output above' : 'N/A'}`);
    } else {
      console.log(`   Hash call failed: ${rawHashResult.execResult.exceptionError}`);
    }

    // ===============================================
    // HANKO TEST - RUN FIRST before nonce changes!
    // ===============================================
    console.log('\n📦 Testing settlement with Hanko signature (FIRST, nonce=0)...');

    // First fund some reserves
    await browserVM.debugFundReserves(leftEntity, 1, 1000000000000000000n); // 1 token
    console.log('   ✅ Funded left entity reserves\n');

    // Use the original signature (nonce should still be 0)
    console.log('   Calling settleWithInsurance...');
    console.log(`   Using original sig length: ${sig.length} chars`);
    console.log(`   Using sig prefix: ${sig.slice(0, 50)}...`);

    const hankoResult = await browserVM.settleWithInsurance(
      leftEntity,
      rightEntity,
      diffs,
      [],
      [],
      sig
    );

    console.log(`   Hanko Result:`, JSON.stringify(hankoResult, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

    if (hankoResult.success === false) {
      console.log(`   ❌ Hanko Settlement failed!`);
    } else {
      console.log(`   ✅ Hanko Settlement succeeded!`);
    }
    console.log(`   Events: ${hankoResult.logs?.length || 0}`);

    // Show all events including debug ones
    if (hankoResult.logs && hankoResult.logs.length > 0) {
      for (const ev of hankoResult.logs) {
        if (ev.name) {
          console.log(`     Event: ${ev.name}`);
        }
      }
    }

    // ===============================================
    // REMAINING TESTS (may change nonce)
    // ===============================================

    // Test with 100-byte dummy sig to isolate calldata size issue
    console.log('\n📦 Testing with 100-byte dummy sig (not 65, not Hanko)...');
    {
      const dummySig100 = ethers.hexlify(new Uint8Array(100).fill(0xab));
      console.log(`   Dummy sig length: ${(dummySig100.length - 2) / 2} bytes`);
      const result100 = await browserVM.settleWithInsurance(
        leftEntity,
        rightEntity,
        diffs,
        [],
        [],
        dummySig100
      );
      console.log(`   100-byte sig result: success=${result100.success}`);
    }

  } catch (err: any) {
    console.log(`   ❌ Error: ${err.message}`);
  }

  console.log('\n✅ Test complete');
}

main().catch(console.error);
