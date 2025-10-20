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
contract SubcontractProvider is Console {
  mapping(bytes32 => uint) public hashToBlock;
  uint MAXUINT32 = type(uint32).max;

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

    uint[] memory lArgs = abi.decode(leftArguments, (uint[]));
    uint[] memory rArgs = abi.decode(rightArguments, (uint[]));
    
    for (uint i = 0; i < decodedBatch.payment.length; i++) {
      applyPayment(deltas, decodedBatch.payment[i]);
    }

    uint leftSwaps = 0;
    for (uint i = 0; i < decodedBatch.swap.length; i++) {
      Swap memory swap = decodedBatch.swap[i];

      uint32 fillRatio = uint32(swap.ownerIsLeft ? lArgs[leftSwaps] : rArgs[i  - leftSwaps]);

      applySwap(deltas, swap, fillRatio);
      //logDeltas("Deltas after swap", deltas);

      if (swap.ownerIsLeft) {
        leftSwaps++;
      }
    }

    return deltas;
  }

  function applyPayment(int[] memory deltas, Payment memory payment) private {
    // apply amount to delta if revealed on time
    // this is "sprites" approach (https://arxiv.org/pdf/1702.05812) 
    // the opposite is "blitz" (https://www.usenix.org/system/files/sec21fall-aumayr.pdf)
    uint revealedAt = hashToBlock[payment.hash];
    if (revealedAt == 0 || revealedAt > payment.revealedUntilBlock) {
      return;
    }

    logDeltas("Before payment", deltas);
    deltas[payment.deltaIndex] += payment.amount;
    logDeltas("After payment", deltas);
  }

  function applySwap(int[] memory deltas, Swap memory swap, uint32 fillRatio) private {
    logDeltas("Before swap", deltas);
    deltas[swap.addDeltaIndex] += int(swap.addAmount * fillRatio / MAXUINT32);
    deltas[swap.subDeltaIndex] -= int(swap.subAmount * fillRatio / MAXUINT32);
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