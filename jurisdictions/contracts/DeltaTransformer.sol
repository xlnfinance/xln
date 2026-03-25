// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Token.sol";

import "./ECDSA.sol";
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

  This is DeFi within bilateral accounts. Genuinely new.
  */
contract DeltaTransformer {
  error InvalidDeltaIndex();
  mapping(bytes32 => uint) public hashToBlock;
  uint256 constant MAX_FILL_RATIO = type(uint16).max;

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

  function encodeBatch (Batch memory b) public pure returns (bytes memory) {
    return abi.encode(b);
  }



  // applies arbitrary changes to deltas
  function applyBatch(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments
  ) public view returns (int[] memory) {

    Batch memory decodedBatch = abi.decode(encodedBatch, (Batch));

    uint16[] memory lFillRatios;
    uint16[] memory rFillRatios;
    bytes32[] memory lSecrets;
    bytes32[] memory rSecrets;
    if (leftArguments.length > 0) {
      (lFillRatios, lSecrets) = abi.decode(leftArguments, (uint16[], bytes32[]));
    } else {
      lFillRatios = new uint16[](0);
      lSecrets = new bytes32[](0);
    }
    if (rightArguments.length > 0) {
      (rFillRatios, rSecrets) = abi.decode(rightArguments, (uint16[], bytes32[]));
    } else {
      rFillRatios = new uint16[](0);
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
      uint16 fillRatio = 0;
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

  function applyPayment(int[] memory deltas, Payment memory payment, bytes32[] memory lSecrets, bytes32[] memory rSecrets) private view {
    // Apply amount to delta if revealed on time.
    // Runtime default: secrets are passed in `lSecrets/rSecrets` via dispute arguments (calldata path).
    // Storage registry (`hashToBlock`) is kept as compatibility/debug fallback only.
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
    if (payment.deltaIndex >= deltas.length) revert InvalidDeltaIndex();

    deltas[payment.deltaIndex] += payment.amount;
  }

  function matchesSecret(bytes32 hashlock, bytes32[] memory secrets) private pure returns (bool) {
    for (uint i = 0; i < secrets.length; i++) {
      if (keccak256(abi.encode(secrets[i])) == hashlock) {
        return true;
      }
    }
    return false;
  }

  function applySwap(int[] memory deltas, Swap memory swap, uint16 fillRatio) private pure {
    if (swap.addDeltaIndex >= deltas.length || swap.subDeltaIndex >= deltas.length) revert InvalidDeltaIndex();
    deltas[swap.addDeltaIndex] += int(swap.addAmount * fillRatio / MAX_FILL_RATIO);
    deltas[swap.subDeltaIndex] -= int(swap.subAmount * fillRatio / MAX_FILL_RATIO);
  }





  function revealSecret(bytes32 secret) public {
    // Compatibility/debug helper: writes hash reveal into on-chain registry.
    // Current runtime payment/dispute flow does not require this for normal settlement.
    hashToBlock[keccak256(abi.encode(secret))] = block.number;
  }
  
  // anyone can get gas refund by deleting very old revealed secrets
  function cleanSecret(bytes32 hash) public {
    if (hashToBlock[hash] != 0 && hashToBlock[hash] < block.number - 100000){
      delete hashToBlock[hash];
    }
  }
}
