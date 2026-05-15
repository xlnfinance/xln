// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HashLadder.sol";

/// @title CrossSwapPull
/// @notice Delta transformer for cross-jurisdiction pull legs with uint16 hash-ladder fill proofs.
/// @dev The ladder is never stored on chain. The signed proof stores only the encoded pull
///      commitments; revealed ladder nodes are passed in dispute arguments. `Depository` should call
///      `applyBatchWithArgumentBlocks` so the transformer can check the actual dispute argument block.
contract CrossSwapPull {
  error InvalidDeltaIndex();
  error SecretRegistryDisabled();

  uint256 constant MAX_FILL_RATIO = type(uint16).max;

  struct Batch {
    Pull[] pulls;
  }

  struct Pull {
    bool ownerIsLeft;
    uint addDeltaIndex;
    uint amount;
    uint subDeltaIndex;
    uint revealedUntilBlock;
    bytes32 fullHash;
    bytes32 partialRoot;
  }

  function encodeBatch(Batch memory b) public pure returns (bytes memory) {
    return abi.encode(b);
  }

  function applyBatch(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments
  ) public view returns (int[] memory) {
    return _applyBatch(deltas, encodedBatch, leftArguments, rightArguments, block.number, block.number);
  }

  function supportsArgumentBlocks() external pure returns (bool) {
    return true;
  }

  function applyBatchWithArgumentBlocks(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments,
    uint leftArgumentsBlock,
    uint rightArgumentsBlock
  ) external pure returns (int[] memory) {
    return _applyBatch(deltas, encodedBatch, leftArguments, rightArguments, leftArgumentsBlock, rightArgumentsBlock);
  }

  function revealSecret(bytes32) public pure {
    revert SecretRegistryDisabled();
  }

  function hashToBlock(bytes32) public pure returns (uint) {
    return 0;
  }

  function _applyBatch(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments,
    uint leftArgumentsBlock,
    uint rightArgumentsBlock
  ) private pure returns (int[] memory) {
    Batch memory decodedBatch = abi.decode(encodedBatch, (Batch));
    bytes[] memory left = _decodeArguments(leftArguments);
    bytes[] memory right = _decodeArguments(rightArguments);

    uint leftPulls = 0;
    uint rightPulls = 0;
    for (uint i = 0; i < decodedBatch.pulls.length; i++) {
      Pull memory pull = decodedBatch.pulls[i];
      if (pull.ownerIsLeft) {
        bytes memory pullArg = rightPulls < right.length ? right[rightPulls] : bytes("");
        _applyPull(deltas, pull, pullArg, rightArgumentsBlock);
        rightPulls++;
      } else {
        bytes memory pullArg = leftPulls < left.length ? left[leftPulls] : bytes("");
        _applyPull(deltas, pull, pullArg, leftArgumentsBlock);
        leftPulls++;
      }
    }

    return deltas;
  }

  function _decodeArguments(bytes calldata encoded) private pure returns (bytes[] memory args) {
    if (encoded.length > 0) {
      return abi.decode(encoded, (bytes[]));
    }
    return new bytes[](0);
  }

  function _applyPull(
    int[] memory deltas,
    Pull memory pull,
    bytes memory pullArg,
    uint argumentsBlock
  ) private pure {
    if (pull.addDeltaIndex >= deltas.length || pull.subDeltaIndex >= deltas.length) {
      revert InvalidDeltaIndex();
    }

    uint16 fillRatio = _verifiedFillRatio(pull, pullArg, argumentsBlock);
    if (fillRatio == 0) return;

    uint amount = pull.amount * fillRatio / MAX_FILL_RATIO;
    deltas[pull.addDeltaIndex] += int(amount);
    deltas[pull.subDeltaIndex] -= int(amount);
  }

  function _verifiedFillRatio(
    Pull memory pull,
    bytes memory pullArg,
    uint argumentsBlock
  ) private pure returns (uint16) {
    if (pullArg.length == 0) return 0;
    if (argumentsBlock > pull.revealedUntilBlock) return 0;

    if (pullArg.length == 32) {
      bytes32 fullSecret;
      assembly ("memory-safe") {
        fullSecret := mload(add(pullArg, 0x20))
      }
      if (!HashLadder.verifyFull(pull.fullHash, fullSecret)) return 0;
      return type(uint16).max;
    }

    if (pullArg.length != 130) return 0;
    uint16 fillRatio = (uint16(uint8(pullArg[0])) << 8) | uint16(uint8(pullArg[1]));
    if (fillRatio == 0 || fillRatio == type(uint16).max) return 0;

    bytes32[4] memory reveals;
    assembly ("memory-safe") {
      let data := add(pullArg, 0x22)
      mstore(reveals, mload(data))
      mstore(add(reveals, 0x20), mload(add(data, 0x20)))
      mstore(add(reveals, 0x40), mload(add(data, 0x40)))
      mstore(add(reveals, 0x60), mload(add(data, 0x60)))
    }
    if (!HashLadder.verifyPartial(pull.partialRoot, fillRatio, reveals)) return 0;
    return fillRatio;
  }
}
