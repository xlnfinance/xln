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

  // actual subcontracts
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
  function process(SubcontractParams memory params) public view returns (int[] memory deltas) {
    (Payment[] memory payments, 
    Swap[] memory swaps) = abi.decode(params.data, (Payment[], Swap[]));

    uint[] memory left_args = abi.decode(params.left_arguments, (uint[]));

    deltas = params.deltas;

    for (uint i = 0; i < payments.length; i++) {
      Payment memory payment = payments[i];
      uint revealed_at = hashToBlock[payment.hash];

      // apply amount to delta if revealed on-time, otherwise ignore
      // this is "sprites" approach (https://arxiv.org/pdf/1702.05812) 
      // the opposite is "blitz" (https://www.usenix.org/system/files/sec21fall-aumayr.pdf)
      if (revealed_at > 0 && revealed_at <= payment.revealedUntilBlock) {
        deltas[payment.deltaIndex] += payment.amount;
      }
      

    }




    return deltas;

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