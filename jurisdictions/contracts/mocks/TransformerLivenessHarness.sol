// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @dev Adversarial transformer used by the real Depository dispute tests.
///      Every mode implements the canonical production ABI so the test exercises
///      Depository's call boundary rather than a synthetic wrapper.
contract TransformerLivenessHarness {
  enum Mode {
    Add,
    Absolute,
    RevertCall,
    ExhaustGas,
    ShortReturn,
    WrongLength,
    MalformedReturn,
    ReturnBomb
  }

  error HarnessRevert();
  error TokenContextMismatch(uint256 expected, uint256 actual);
  error DeltaIndexOutOfBounds(uint256 index, uint256 length);

  function encode(Mode mode, uint256 deltaIndex, int256 value, uint256 expectedTokenId)
    external
    pure
    returns (bytes memory)
  {
    return abi.encode(mode, deltaIndex, value, expectedTokenId);
  }

  function applyBatch(
    int256[] calldata deltas,
    uint256[] calldata tokenIds,
    bytes calldata encodedBatch,
    bytes calldata,
    bytes calldata,
    uint256,
    uint256
  ) external pure returns (int256[] memory result) {
    (Mode mode, uint256 deltaIndex, int256 value, uint256 expectedTokenId) =
      abi.decode(encodedBatch, (Mode, uint256, int256, uint256));

    if (mode == Mode.RevertCall) revert HarnessRevert();
    if (mode == Mode.ExhaustGas) {
      assembly ("memory-safe") {
        for { } 1 { } { }
      }
    }
    if (mode == Mode.ShortReturn) {
      assembly ("memory-safe") {
        mstore(0x00, 0x20)
        return(0x00, 0x20)
      }
    }
    if (mode == Mode.MalformedReturn) {
      uint256 expectedSize = 0x40 + deltas.length * 0x20;
      assembly ("memory-safe") {
        let output := mload(0x40)
        mstore(output, 0)
        mstore(add(output, 0x20), calldataload(deltas.offset))
        return(output, expectedSize)
      }
    }
    if (mode == Mode.ReturnBomb) {
      assembly ("memory-safe") {
        let output := mload(0x40)
        mstore(output, 0x20)
        mstore(add(output, 0x20), 0x100000)
        return(output, 0x10000)
      }
    }

    if (deltaIndex >= deltas.length) revert DeltaIndexOutOfBounds(deltaIndex, deltas.length);
    if (deltaIndex >= tokenIds.length) revert DeltaIndexOutOfBounds(deltaIndex, tokenIds.length);
    if (tokenIds[deltaIndex] != expectedTokenId) {
      revert TokenContextMismatch(expectedTokenId, tokenIds[deltaIndex]);
    }

    uint256 outputLength = mode == Mode.WrongLength ? deltas.length + 1 : deltas.length;
    result = new int256[](outputLength);
    for (uint256 i = 0; i < deltas.length; i++) result[i] = deltas[i];
    if (mode == Mode.Add) result[deltaIndex] += value;
    if (mode == Mode.Absolute) result[deltaIndex] = value;
  }
}
