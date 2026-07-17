// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Mock is ERC20 {
    uint8 private immutable tokenDecimals;

    constructor(string memory name, string memory symbol, uint8 decimals_, uint256 initialSupply) ERC20(name, symbol) {
        tokenDecimals = decimals_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    /// @notice Unrestricted mint for testing — anyone can mint any amount
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
