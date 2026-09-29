// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

contract SupplyLivenessHarness {
  enum Mode {
    Normal,
    BurnGas,
    ReturnBomb
  }

  uint256 private immutable fixedSupply;
  Mode public mode;

  constructor(uint256 supply) {
    fixedSupply = supply;
  }

  function setMode(Mode nextMode) external {
    mode = nextMode;
  }

  function totalSupply() external view returns (uint256) {
    if (mode == Mode.BurnGas) {
      assembly ("memory-safe") {
        for { } 1 { } { }
      }
    }
    if (mode == Mode.ReturnBomb) {
      assembly ("memory-safe") {
        mstore(0, sload(mode.slot))
        return(0, 0x200000)
      }
    }
    return fixedSupply;
  }
}
