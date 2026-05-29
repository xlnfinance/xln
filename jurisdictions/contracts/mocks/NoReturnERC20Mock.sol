// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract NoReturnERC20Mock {
  string public name;
  string public symbol;
  uint8 public constant decimals = 18;
  uint256 public totalSupply;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  constructor(string memory name_, string memory symbol_, uint256 initialSupply) {
    name = name_;
    symbol = symbol_;
    balanceOf[msg.sender] = initialSupply;
    totalSupply = initialSupply;
  }

  function approve(address spender, uint256 amount) external {
    allowance[msg.sender][spender] = amount;
  }

  function transfer(address to, uint256 amount) external {
    _move(msg.sender, to, amount);
  }

  function transferFrom(address from, address to, uint256 amount) external {
    uint256 currentAllowance = allowance[from][msg.sender];
    require(currentAllowance >= amount, "allowance");
    allowance[from][msg.sender] = currentAllowance - amount;
    _move(from, to, amount);
  }

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
    totalSupply += amount;
  }

  function _move(address from, address to, uint256 amount) private {
    require(balanceOf[from] >= amount, "balance");
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
  }
}
