// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
pragma experimental ABIEncoderV2;

import "./Token.sol";

import "./ECDSA.sol";
import "./console.sol";
import "hardhat/console.sol";
/* 
Subcontracts - Programmable Delta Transformers
  function applyBatch(int[] memory deltas, bytes calldata encodedBatch,
                      bytes calldata leftArguments, bytes calldata rightArguments)
    → int[] memory newDeltas

  What you can do:
  - HTLCs (conditional payments based on secret reveal)
  - Atomic swaps (exchange token A for token B, all-or-nothing)
  - Any programmable state transition within bilateral account

  First in history: Lightning only has HTLCs hardcoded. You're generalizing it - arbitrary logic can transform delta arrays. The applySwap() function (line
   105) shows fillRatio execution (0-100% fill of limit order).

  This is DeFi within bilateral channels. Genuinely new.
  */
contract DeltaTransformer is Console {
  mapping(bytes32 => uint) public hashToBlock;
  uint MAX_FILL_RATIO = type(uint16).max;

  constructor() {
    revealSecret(bytes32(0));
  }
  
  struct Batch {
    Payment[] payment;
    Swap[] swap;
  }

  // actual subcontract structs
  struct Payment {
    uint deltaIndex;
    int amount;
    uint revealedUntilBlock;
    bytes32 hash;
  }

  struct Swap {
    bool ownerIsLeft;

    uint addDeltaIndex;
    uint addAmount;

    uint subDeltaIndex;
    uint subAmount;
  }

  // https://en.wikipedia.org/wiki/Credit_default_swap
  struct CreditDefaultSwap {
    uint deltaIndex;
    int amount;
    address referenceEntity;
    uint tokenId;
    uint exerciseUntilBlock;
  }

  function encodeBatch (Batch memory b) public pure returns (bytes memory) {
    return abi.encode(b);
  }



  // applies arbitrary changes to deltas
  function applyBatch(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments
  ) public returns (int[] memory) {

    Batch memory decodedBatch = abi.decode(encodedBatch, (Batch));

    uint32[] memory lFillRatios;
    uint32[] memory rFillRatios;
    bytes32[] memory lSecrets;
    bytes32[] memory rSecrets;
    if (leftArguments.length > 0) {
      (lFillRatios, lSecrets) = abi.decode(leftArguments, (uint32[], bytes32[]));
    } else {
      lFillRatios = new uint32[](0);
      lSecrets = new bytes32[](0);
    }
    if (rightArguments.length > 0) {
      (rFillRatios, rSecrets) = abi.decode(rightArguments, (uint32[], bytes32[]));
    } else {
      rFillRatios = new uint32[](0);
      rSecrets = new bytes32[](0);
    }
    
    for (uint i = 0; i < decodedBatch.payment.length; i++) {
      applyPayment(deltas, decodedBatch.payment[i], lSecrets, rSecrets);
    }

    uint leftSwaps = 0;
    uint rightSwaps = 0;
    for (uint i = 0; i < decodedBatch.swap.length; i++) {
      Swap memory swap = decodedBatch.swap[i];

      // Counterparty chooses fill ratio (maker doesn't).
      // Left-owned swap -> use right arguments; Right-owned swap -> use left arguments.
      uint32 fillRatio = 0;
      if (swap.ownerIsLeft) {
        if (rightSwaps < rFillRatios.length) fillRatio = rFillRatios[rightSwaps];
        rightSwaps++;
      } else {
        if (leftSwaps < lFillRatios.length) fillRatio = lFillRatios[leftSwaps];
        leftSwaps++;
      }

      applySwap(deltas, swap, fillRatio);
      //logDeltas("Deltas after swap", deltas);
    }

    return deltas;
  }

  function applyPayment(int[] memory deltas, Payment memory payment, bytes32[] memory lSecrets, bytes32[] memory rSecrets) private {
    // Apply amount to delta if revealed on time.
    // Primary: calldata secrets (no storage). Fallback: on-chain registry (hashToBlock).
    uint revealedAt = hashToBlock[payment.hash];
    bool revealed = false;
    if (revealedAt != 0 && revealedAt <= payment.revealedUntilBlock) {
      revealed = true;
    }
    if (!revealed && block.number <= payment.revealedUntilBlock) {
      if (matchesSecret(payment.hash, lSecrets) || matchesSecret(payment.hash, rSecrets)) {
        revealed = true;
      }
    }
    if (!revealed) return;

    logDeltas("Before payment", deltas);
    deltas[payment.deltaIndex] += payment.amount;
    logDeltas("After payment", deltas);
  }

  function matchesSecret(bytes32 hashlock, bytes32[] memory secrets) private pure returns (bool) {
    for (uint i = 0; i < secrets.length; i++) {
      if (keccak256(abi.encode(secrets[i])) == hashlock) {
        return true;
      }
    }
    return false;
  }

  function applySwap(int[] memory deltas, Swap memory swap, uint32 fillRatio) private {
    logDeltas("Before swap", deltas);
    deltas[swap.addDeltaIndex] += int(swap.addAmount * fillRatio / MAX_FILL_RATIO);
    deltas[swap.subDeltaIndex] -= int(swap.subAmount * fillRatio / MAX_FILL_RATIO);
    logDeltas("After swap", deltas);
  }





  function revealSecret(bytes32 secret) public {
    console.log("Revealing HTLC secret:");
    console.logBytes32(secret);
    console.logBytes32(keccak256(abi.encode(secret)));
    hashToBlock[keccak256(abi.encode(secret))] = block.number;
  }
  
  // anyone can get gas refund by deleting very old revealed secrets
  function cleanSecret(bytes32 hash) public {
    if (hashToBlock[hash] != 0 && hashToBlock[hash] < block.number - 100000){
      delete hashToBlock[hash];
    }
  }

  function logDeltas(string memory _msg, int[] memory deltas) public pure {
    console.log(_msg);
    for (uint i = 0; i < deltas.length; i++) {
      console.logInt(deltas[i]);
    }
    console.log('====================');
  }



}
