// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

enum ProposerType { BOARD, CONTROL, DIVIDEND, FOUNDATION }

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
  uint256 activateAtBlock;
  uint256 registrationBlock;
  ProposerType proposerType;
  EntityArticles articles;
}

struct Board {
  uint16 votingThreshold;
  bytes32[] entityIds;
  uint16[] votingPowers;
  uint32 boardChangeDelay;
  uint32 controlChangeDelay;
  uint32 dividendChangeDelay;
}
