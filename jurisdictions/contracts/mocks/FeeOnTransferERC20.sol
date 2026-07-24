// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FeeOnTransferERC20 is ERC20 {
  uint256 private constant FEE_BPS = 100;

  constructor(uint256 initialSupply) ERC20("Fee On Transfer", "FEE") {
    _mint(msg.sender, initialSupply);
  }

  function _update(address from, address to, uint256 amount) internal override {
    if (from == address(0) || to == address(0)) {
      super._update(from, to, amount);
      return;
    }
    uint256 fee = amount * FEE_BPS / 10_000;
    super._update(from, to, amount - fee);
    if (fee > 0) super._update(from, address(0), fee);
  }
}
