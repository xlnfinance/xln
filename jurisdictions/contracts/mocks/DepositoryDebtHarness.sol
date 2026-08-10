// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "../Depository.sol";

contract DepositoryDebtHarness is Depository {
  constructor(address entityProvider_, address deltaTransformer_)
    Depository(entityProvider_, deltaTransformer_)
  {}

  function harnessAddDebt(bytes32 debtor, uint256 tokenId, bytes32 creditor, uint256 amount) external {
    _addDebt(debtor, tokenId, creditor, amount);
  }

  function harnessForgiveCurrent(bytes32 debtor, bytes32 creditor, uint256 tokenId)
    external returns (bool hasCurrentDebt, bool forgiven)
  {
    return _forgiveDebtsBetweenEntities(debtor, creditor, tokenId);
  }
}
