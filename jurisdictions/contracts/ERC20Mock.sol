// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Mock is ERC20 {
    constructor(string memory name, string memory symbol, uint256 initialSupply) ERC20(name, symbol) {
        _mint(msg.sender, initialSupply);
    }

    /// @notice Unrestricted mint for testing — anyone can mint any amount
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}