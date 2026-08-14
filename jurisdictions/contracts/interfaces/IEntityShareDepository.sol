// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IEntityShareDepository {
  function registerExternalToken(uint8 tokenType, address contractAddress, uint256 externalTokenId) external;
}
