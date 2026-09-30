// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface INftCustodyERC721 {
  function transferFrom(address from, address to, uint256 tokenId) external;
  function ownerOf(uint256 tokenId) external view returns (address);
}

interface INftCustodyERC1155 {
  function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external;
  function balanceOf(address account, uint256 id) external view returns (uint256);
}

/**
 * NFT custody product shared by every Depository entrypoint.
 *
 * External library calls execute by DELEGATECALL: address(this) remains the
 * Depository and msg.sender remains the signed batch caller. This preserves
 * custody/approval semantics while keeping the EIP-170 constrained court
 * contract small. A token call returning success is never sufficient: the
 * exact owner/balance transition is the accounting authority.
 */
library NftCustody {
  error E11();

  function depositERC721(address token, uint256 externalTokenId) external {
    INftCustodyERC721 nft = INftCustodyERC721(token);
    nft.transferFrom(msg.sender, address(this), uint256(externalTokenId));
    if (nft.ownerOf(uint256(externalTokenId)) != address(this)) revert E11();
  }

  function depositERC1155(address token, uint256 externalTokenId, uint256 amount) external {
    INftCustodyERC1155 nft = INftCustodyERC1155(token);
    uint256 beforeBalance = nft.balanceOf(address(this), uint256(externalTokenId));
    nft.safeTransferFrom(msg.sender, address(this), uint256(externalTokenId), amount, "");
    uint256 afterBalance = nft.balanceOf(address(this), uint256(externalTokenId));
    if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert E11();
  }

  function withdrawERC721(address token, uint256 externalTokenId, address recipient) external {
    INftCustodyERC721 nft = INftCustodyERC721(token);
    if (nft.ownerOf(uint256(externalTokenId)) != address(this)) revert E11();
    nft.transferFrom(address(this), recipient, uint256(externalTokenId));
    if (nft.ownerOf(uint256(externalTokenId)) != recipient) revert E11();
  }

  function withdrawERC1155(address token, uint256 externalTokenId, uint256 amount, address recipient) external {
    INftCustodyERC1155 nft = INftCustodyERC1155(token);
    uint256 beforeSender = nft.balanceOf(address(this), uint256(externalTokenId));
    uint256 beforeRecipient = nft.balanceOf(recipient, uint256(externalTokenId));
    nft.safeTransferFrom(address(this), recipient, uint256(externalTokenId), amount, "");
    uint256 afterSender = nft.balanceOf(address(this), uint256(externalTokenId));
    uint256 afterRecipient = nft.balanceOf(recipient, uint256(externalTokenId));
    if (
      beforeSender < amount ||
      afterSender != beforeSender - amount ||
      afterRecipient < beforeRecipient ||
      afterRecipient - beforeRecipient != amount
    ) revert E11();
  }
}
