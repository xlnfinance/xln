// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/Types.sol";

contract SecretRevealIngressTest is XlnFixture {
  function setUp() public { _deployXln(); }

  function test_fixpay_1_direct_transformer_reveal_cannot_create_unwatched_evidence() public {
    bytes32 secret = keccak256("bob-direct-reveal");
    bytes32 hashlock = keccak256(abi.encode(secret));
    vm.prank(signer[1]);
    (bool ok,) = address(deltaTransformer).call(abi.encodeWithSignature("revealSecret(bytes32)", secret));
    assertFalse(ok, "unwatched public reveal must reject");
    assertEq(deltaTransformer.hashToTimestamp(hashlock), 0);
    Batch memory b = XlnHanko.emptyBatch();
    b.revealSecrets = new SecretReveal[](1);
    b.revealSecrets[0] = SecretReveal({transformer: address(deltaTransformer), secret: secret});
    assertTrue(_submit(1, b));
    uint firstSeen = deltaTransformer.hashToTimestamp(hashlock);
    assertGt(firstSeen, 0);
    vm.warp(block.timestamp + 10);
    assertTrue(_submit(1, b));
    assertEq(deltaTransformer.hashToTimestamp(hashlock), firstSeen);
  }
}
