// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IEntityShareDepository {
  function entityProvider() external view returns (address);
  function registerExternalToken(uint8 tokenType, address contractAddress, uint256 externalTokenId)
    external returns (uint256 tokenId);
  function _reserves(bytes32 entityId, uint256 tokenId) external view returns (uint256);
  function _status() external view returns (uint256);
}
