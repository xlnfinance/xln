// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Test-only (reviewer B, RB-7, PR 64): a listed share Depository that misbehaves on the CONTROL-lane reads of EntityProvider._requireReserveControlMajority.
/// mode 0: reverts. mode 1: returns 2 MiB of zeros (return bomb). mode 2: burns all its gas (invalid opcode).
contract MisbehavingShareDepository {
  address public immutable entityProvider;
  uint256 public immutable mode;

  constructor(address entityProvider_, uint256 mode_) {
    entityProvider = entityProvider_;
    mode = mode_;
  }

  function registerExternalToken(uint8, address, uint256) external pure returns (uint256) {
    return 1;
  }

  function _status() external view returns (uint256) {
    uint256 m = mode;
    assembly ("memory-safe") {
      if eq(m, 0) { revert(0, 0) }
      if eq(m, 2) { invalid() }
    }
    // mode 1: return as much as this frame's gas pays for (memory cost 3w + w^2/512 <= 0.9 gas), so the caller, who holds only
    // 1/64 of the gas, can never afford to copy it
    uint256 budget = gasleft() * 9 / 10;
    uint256 w = _sqrt(budget * 512);
    if (w > 3 * 1024 * 1024 / 32 * 4) w = 3 * 1024 * 1024 / 32 * 4;
    assembly ("memory-safe") { return(0, mul(w, 0x20)) }
  }

  function _sqrt(uint256 x) private pure returns (uint256 y) {
    if (x == 0) return 0;
    y = x;
    uint256 z = (x + 1) / 2;
    while (z < y) { y = z; z = (x / z + z) / 2; }
  }

  function _reserves(bytes32, uint256) external view returns (uint256) {
    return this._status();
  }

  function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
    return 0xf23a6e61;
  }
}
