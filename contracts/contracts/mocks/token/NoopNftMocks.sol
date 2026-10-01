// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract NoopERC721Mock {
  address private immutable reportedOwner;

  constructor(address owner) {
    reportedOwner = owner;
  }

  function ownerOf(uint256) external view returns (address) {
    return reportedOwner;
  }

  function transferFrom(address, address, uint256) external pure {}
}

contract NoopERC1155Mock {
  address private immutable reportedOwner;

  constructor(address owner) {
    reportedOwner = owner;
  }

  function totalSupply(uint256) external pure returns (uint256) {
    return 100;
  }

  function balanceOf(address owner, uint256) external view returns (uint256) {
    return owner == reportedOwner ? 100 : 0;
  }

  function safeTransferFrom(address, address, uint256, uint256, bytes calldata) external pure {}
}

contract ToggleNoopERC721Mock {
  address private currentOwner;
  bool public noop;

  constructor(address owner) {
    currentOwner = owner;
  }

  function setNoop(bool value) external {
    noop = value;
  }

  function ownerOf(uint256) external view returns (address) {
    return currentOwner;
  }

  function transferFrom(address from, address to, uint256) external {
    if (!noop) {
      require(currentOwner == from, "OWNER");
      currentOwner = to;
    }
  }
}

contract ToggleNoopERC1155Mock {
  mapping(address => uint256) private balances;
  bool public noop;

  constructor(address owner) {
    balances[owner] = 100;
  }

  function setNoop(bool value) external {
    noop = value;
  }

  function totalSupply(uint256) external pure returns (uint256) {
    return 100;
  }

  function balanceOf(address owner, uint256) external view returns (uint256) {
    return balances[owner];
  }

  function safeTransferFrom(address from, address to, uint256, uint256 amount, bytes calldata) external {
    if (!noop) {
      require(balances[from] >= amount, "BALANCE");
      balances[from] -= amount;
      balances[to] += amount;
    }
  }
}
