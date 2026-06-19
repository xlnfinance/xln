// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "../EntityProvider.sol";

contract EntityProviderSupplyHarness is EntityProvider {
  function harnessMint(address to, uint256 id, uint256 amount) external {
    _mint(to, id, amount, "");
  }

  function harnessBurn(address from, uint256 id, uint256 amount) external {
    _burn(from, id, amount);
  }
}
