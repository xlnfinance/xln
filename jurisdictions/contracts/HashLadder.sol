// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HashLadder
/// @notice Verifies uint16 fill ratios with a full-fill fast path and four nibble hash ladders.
/// @dev Use five deterministic off-chain secrets:
///      - fullSecret: commits to 100% fill with one hash.
///      - nibbleBase[0..3]: each commits to one hex nibble of a uint16 fill ratio.
///
///      Nibble order is big-endian: index 0 is the most significant hex nibble.
///      For a nibble digit d:
///        root = H^15(base)
///        reveal = H^(15 - d)(base)
///        verifier hashes reveal d times and gets root.
///
///      This makes zero digits cheapest and keeps higher fills permissioned:
///      knowing a lower-digit reveal cannot derive a higher-digit reveal.
library HashLadder {
  uint8 internal constant NIBBLE_COUNT = 4;
  uint8 internal constant MAX_NIBBLE = 15;
  uint16 internal constant FULL_FILL_RATIO = type(uint16).max;

  error InvalidNibbleIndex();
  error InvalidNibbleValue();

  struct Commitment {
    bytes32 fullHash;
    bytes32 partialRoot;
  }

  function hashNode(bytes32 node) internal pure returns (bytes32 digest) {
    assembly ("memory-safe") {
      mstore(0x00, node)
      digest := keccak256(0x00, 0x20)
    }
  }

  function hashSteps(bytes32 node, uint8 steps) internal pure returns (bytes32 result) {
    result = node;
    unchecked {
      for (uint8 i = 0; i < steps; i++) {
        result = hashNode(result);
      }
    }
  }

  function hashFullSecret(bytes32 fullSecret) internal pure returns (bytes32) {
    return hashNode(fullSecret);
  }

  function nibbleAt(uint16 fillRatio, uint8 index) internal pure returns (uint8) {
    if (index >= NIBBLE_COUNT) revert InvalidNibbleIndex();
    unchecked {
      return uint8((fillRatio >> ((NIBBLE_COUNT - 1 - index) * 4)) & 0x0f);
    }
  }

  function rootFromBase(bytes32 base) internal pure returns (bytes32) {
    return hashSteps(base, MAX_NIBBLE);
  }

  function revealForNibble(bytes32 base, uint8 digit) internal pure returns (bytes32) {
    if (digit > MAX_NIBBLE) revert InvalidNibbleValue();
    unchecked {
      return hashSteps(base, MAX_NIBBLE - digit);
    }
  }

  function rootFromReveal(bytes32 reveal, uint8 digit) internal pure returns (bytes32) {
    if (digit > MAX_NIBBLE) revert InvalidNibbleValue();
    return hashSteps(reveal, digit);
  }

  function partialRootFromRoots(bytes32[4] memory roots) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(roots[0], roots[1], roots[2], roots[3]));
  }

  function partialRootFromReveals(uint16 fillRatio, bytes32[4] memory reveals) internal pure returns (bytes32) {
    bytes32[4] memory roots;
    unchecked {
      for (uint8 i = 0; i < NIBBLE_COUNT; i++) {
        roots[i] = rootFromReveal(reveals[i], nibbleAt(fillRatio, i));
      }
    }
    return partialRootFromRoots(roots);
  }

  function partialRootFromRevealsCalldata(
    uint16 fillRatio,
    bytes32[4] calldata reveals
  ) internal pure returns (bytes32) {
    bytes32[4] memory roots;
    unchecked {
      for (uint8 i = 0; i < NIBBLE_COUNT; i++) {
        roots[i] = rootFromReveal(reveals[i], nibbleAt(fillRatio, i));
      }
    }
    return partialRootFromRoots(roots);
  }

  function buildCommitment(
    bytes32 fullSecret,
    bytes32[4] memory nibbleBases
  ) internal pure returns (Commitment memory commitment) {
    bytes32[4] memory roots;
    unchecked {
      for (uint8 i = 0; i < NIBBLE_COUNT; i++) {
        roots[i] = rootFromBase(nibbleBases[i]);
      }
    }
    commitment.fullHash = hashFullSecret(fullSecret);
    commitment.partialRoot = partialRootFromRoots(roots);
  }

  function buildCommitmentCalldata(
    bytes32 fullSecret,
    bytes32[4] calldata nibbleBases
  ) internal pure returns (Commitment memory commitment) {
    bytes32[4] memory roots;
    unchecked {
      for (uint8 i = 0; i < NIBBLE_COUNT; i++) {
        roots[i] = rootFromBase(nibbleBases[i]);
      }
    }
    commitment.fullHash = hashFullSecret(fullSecret);
    commitment.partialRoot = partialRootFromRoots(roots);
  }

  function verifyFull(bytes32 expectedFullHash, bytes32 fullSecret) internal pure returns (bool) {
    return hashFullSecret(fullSecret) == expectedFullHash;
  }

  function verifyPartial(
    bytes32 expectedPartialRoot,
    uint16 fillRatio,
    bytes32[4] memory reveals
  ) internal pure returns (bool) {
    if (fillRatio == FULL_FILL_RATIO) return false;
    return partialRootFromReveals(fillRatio, reveals) == expectedPartialRoot;
  }

  function verifyPartialCalldata(
    bytes32 expectedPartialRoot,
    uint16 fillRatio,
    bytes32[4] calldata reveals
  ) internal pure returns (bool) {
    if (fillRatio == FULL_FILL_RATIO) return false;
    return partialRootFromRevealsCalldata(fillRatio, reveals) == expectedPartialRoot;
  }

  function verify(
    Commitment memory commitment,
    uint16 fillRatio,
    bytes32 fullSecret,
    bytes32[4] memory reveals
  ) internal pure returns (bool) {
    if (fillRatio == FULL_FILL_RATIO) {
      return verifyFull(commitment.fullHash, fullSecret);
    }
    return verifyPartial(commitment.partialRoot, fillRatio, reveals);
  }

  function verifyCalldata(
    Commitment memory commitment,
    uint16 fillRatio,
    bytes32 fullSecret,
    bytes32[4] calldata reveals
  ) internal pure returns (bool) {
    if (fillRatio == FULL_FILL_RATIO) {
      return verifyFull(commitment.fullHash, fullSecret);
    }
    return verifyPartialCalldata(commitment.partialRoot, fillRatio, reveals);
  }
}
