// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

enum ProposerType { BOARD, CONTROL, DIVIDEND, FOUNDATION }

/// @notice Governance reaction windows in jurisdiction SECONDS, never blocks.
/// @dev Block times differ per chain (250 ms L2s, L1-numbered Arbitrum blocks,
///      12 s Ethereum). A block count is a different security horizon on every
///      chain; a second is the same everywhere. Disputes already use seconds.
struct EntityArticles {
  uint32 controlDelay;
  uint32 dividendDelay;
  uint32 foundationDelay;
}

struct Entity {
  bytes32 currentBoardHash;
  bytes32 previousBoardHash;
  uint256 previousBoardValidUntil;
  bytes32 proposedBoardHash;
  // Unix seconds at which the pending proposal may be activated.
  uint256 activateAt;
  uint256 registrationBlock;
  ProposerType proposerType;
  EntityArticles articles;
  // Second historical slot. With one slot, activation had to wait for the
  // previous board's 7-day evidence grace, so a compromised NEW board ruled
  // for a week. Two slots let the next activation land immediately while both
  // retired boards keep dispute-evidence authority until their own expiry.
  bytes32 previousBoardHash2;
  uint256 previousBoardValidUntil2;
}

struct Board {
  uint16 votingThreshold;
  bytes32[] entityIds;
  uint16[] votingPowers;
  uint32 boardChangeDelay;
  uint32 controlChangeDelay;
  uint32 dividendChangeDelay;
}

bytes32 constant ENTITY_TREASURY_DOMAIN = keccak256("XLN_ENTITY_TREASURY_V1");

/// @notice ERC1155 treasury address of numbered entity `entityNumber`.
/// @dev Never `address(uint160(entityNumber))`: low addresses are precompiles or,
///      on several L2s, system contracts WITH code (Arbitrum ArbSys at 0x64).
///      OZ `_mint` runs the receiver acceptance check whenever the target has
///      code, so registering that entity number would revert forever and, since
///      `nextNumber` never skips, halt every later registration on that chain.
function entityTreasury(uint256 entityNumber) pure returns (address) {
  return address(uint160(uint256(keccak256(abi.encode(ENTITY_TREASURY_DOMAIN, entityNumber)))));
}
