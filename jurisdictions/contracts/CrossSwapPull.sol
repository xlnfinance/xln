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

  struct PullArguments {
    uint16[] fillRatios;
    bytes32[] fullSecrets;
    bytes32[4][] reveals;
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
    PullArguments memory left = _decodeArguments(leftArguments);
    PullArguments memory right = _decodeArguments(rightArguments);

    uint leftPulls = 0;
    uint rightPulls = 0;
    for (uint i = 0; i < decodedBatch.pulls.length; i++) {
      Pull memory pull = decodedBatch.pulls[i];
      if (pull.ownerIsLeft) {
        _applyPull(deltas, pull, right, rightPulls, rightArgumentsBlock);
        rightPulls++;
      } else {
        _applyPull(deltas, pull, left, leftPulls, leftArgumentsBlock);
        leftPulls++;
      }
    }

    return deltas;
  }

  function _decodeArguments(bytes calldata encoded) private pure returns (PullArguments memory args) {
    if (encoded.length > 0) {
      return abi.decode(encoded, (PullArguments));
    }
    args.fillRatios = new uint16[](0);
    args.fullSecrets = new bytes32[](0);
    args.reveals = new bytes32[4][](0);
  }

  function _applyPull(
    int[] memory deltas,
    Pull memory pull,
    PullArguments memory args,
    uint argIndex,
    uint argumentsBlock
  ) private pure {
    if (pull.addDeltaIndex >= deltas.length || pull.subDeltaIndex >= deltas.length) {
      revert InvalidDeltaIndex();
    }

    uint16 fillRatio = _verifiedFillRatio(pull, args, argIndex, argumentsBlock);
    if (fillRatio == 0) return;

    uint amount = pull.amount * fillRatio / MAX_FILL_RATIO;
    deltas[pull.addDeltaIndex] += int(amount);
    deltas[pull.subDeltaIndex] -= int(amount);
  }

  function _verifiedFillRatio(
    Pull memory pull,
    PullArguments memory args,
    uint argIndex,
    uint argumentsBlock
  ) private pure returns (uint16) {
    if (argIndex >= args.fillRatios.length) return 0;

    uint16 fillRatio = args.fillRatios[argIndex];
    if (fillRatio == 0) return 0;
    if (argumentsBlock > pull.revealedUntilBlock) return 0;

    if (fillRatio == type(uint16).max) {
      if (argIndex >= args.fullSecrets.length) return 0;
      bytes32 fullSecret = args.fullSecrets[argIndex];
      if (!HashLadder.verifyFull(pull.fullHash, fullSecret)) return 0;
      return fillRatio;
    }

    if (argIndex >= args.reveals.length) return 0;
    bytes32[4] memory reveals = args.reveals[argIndex];
    if (!HashLadder.verifyPartial(pull.partialRoot, fillRatio, reveals)) return 0;
    return fillRatio;
  }
}
