// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
pragma experimental ABIEncoderV2;

import "./Token.sol";

import "./ECDSA.sol";
import "./console.sol";
import "hardhat/console.sol";

contract SubcontractProvider is Console {
  mapping(bytes32 => uint) public hashToBlock;
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
    uint addIndex;
    uint addAmount;

    uint subIndex;
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
  function applyBatch(int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments) public returns (int[] memory) {

    Batch memory decodedBatch = abi.decode(encodedBatch, (Batch));

    uint[] memory lArgs = abi.decode(leftArguments, (uint[]));
    uint[] memory rArgs = abi.decode(rightArguments, (uint[]));
    
    for (uint i = 0; i < decodedBatch.payment.length; i++) {
      applyPayment(deltas, decodedBatch.payment[i]);
    }

    for (uint i = 0; i < decodedBatch.swap.length; i++) {
      applySwap(deltas, decodedBatch.swap[i], lArgs, rArgs);
    }

    return deltas;
  }

  function applyPayment(int[] memory deltas, Payment memory payment) private {
    // apply amount to delta if revealed on-time, otherwise ignore
    // this is "sprites" approach (https://arxiv.org/pdf/1702.05812) 
    // the opposite is "blitz" (https://www.usenix.org/system/files/sec21fall-aumayr.pdf)

    if (hashToBlock[payment.hash] == 0) {
      // never revealed
      return;
    }

    if (hashToBlock[payment.hash] > payment.revealedUntilBlock) {
      // revealed too late
      return;
    }

    console.log("Payment applied");
    console.logInt(deltas[payment.deltaIndex]);
    console.logInt(payment.amount);

    deltas[payment.deltaIndex] += payment.amount;
  }

  function applySwap(int[] memory deltas, Swap memory swap, uint[] memory lArgs, uint[] memory rArgs) private {
    // apply swap to deltas

    //int left = deltas[swap.addIndex] + int(abi.decode(params.leftArguments, (uint[]))[swap.addIndex]);
    //int right = deltas[swap.subIndex] + int(abi.decode(params.rightArguments, (uint[]))[swap.subIndex]);
    /*
    if (left < swap.addAmount) {
      return;
    }

    if (right < swap.subAmount) {
      return;
    }

    deltas[swap.addIndex] -= swap.addAmount;
    deltas[swap.subIndex] += swap.subAmount;*/
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



}