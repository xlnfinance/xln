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
 
  struct SubcontractParams {
    int[] deltas;
    bytes data;
    bytes left_arguments;
    bytes right_arguments;
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



  // applies arbitrary changes to deltas
  function process(SubcontractParams memory params) public returns (int[] memory deltas) {
    Batch memory b = abi.decode(params.data, (Batch));

    uint[] memory left_args = abi.decode(params.left_arguments, (uint[]));

    deltas = params.deltas;

    for (uint i = 0; i < b.payment.length; i++) {
      processPayment(deltas, b.payment[i]);
    }

    for (uint i = 0; i < b.swap.length; i++) {
      processSwap(deltas, b.swap[i], params);
    }

    return deltas;

  }
  function processPayment(int[] memory deltas, Payment memory payment) private {
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

    deltas[payment.deltaIndex] += payment.amount;
  }

  function processSwap(int[] memory deltas, Swap memory swap, SubcontractParams memory params) private {
    // apply swap to deltas

    int left = deltas[swap.addIndex] + int(abi.decode(params.left_arguments, (uint[]))[swap.addIndex]);
    int right = deltas[swap.subIndex] + int(abi.decode(params.right_arguments, (uint[]))[swap.subIndex]);
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