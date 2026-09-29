// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import "../../contracts/Types.sol";

/// @notice Proves the Solidity hanko builder is accepted by the real verifier.
/// Everything else in this directory depends on this being green.
contract SmokeTest is XlnFixture {
  function setUp() public {
    _deployXln();
  }

  function test_lazyEntityAuthorizesBatch() public {
    dep.mintToReserve(entity[0], TOKEN_ERC20, 1_000);
    assertEq(dep._reserves(entity[0], TOKEN_ERC20), 1_000);

    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({
      receivingEntity: entity[1],
      tokenId: TOKEN_ERC20,
      amount: 400
    });

    assertTrue(_submit(0, b));
    assertEq(dep._reserves(entity[0], TOKEN_ERC20), 600);
    assertEq(dep._reserves(entity[1], TOKEN_ERC20), 400);
    assertEq(dep.entityNonces(entity[0]), 1);
  }
}
