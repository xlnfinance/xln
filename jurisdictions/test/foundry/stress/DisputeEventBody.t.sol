// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture, XlnHanko} from "../helpers/XlnFixture.sol";
import "../../../contracts/Types.sol";
import {Vm} from "forge-std/Vm.sol";

contract DisputeEventBodyTest is XlnFixture {
  function setUp() public { _deployXln(); }

  function _body(int256 amount) private pure returns (ProofBody memory body) {
    body.watchSeed = keccak256("event-body");
    body.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    body.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    body.offdeltas = new Int512[](1);
    body.offdeltas[0] = WideMath.fromInt(amount);
    body.tokenIds = new uint256[](1);
    body.tokenIds[0] = 1;
    body.transformers = new TransformerClause[](0);
  }

  function _start(ProofBody memory body) private {
    bytes32 hash = keccak256(abi.encode(body));
    bool proposer = entity[1] < entity[0];
    bytes memory sig = _hanko(1, XlnHanko.disputeProofHash(address(dep),
      XlnHanko.accountKey(entity[0], entity[1]), 1, proposer, hash, body.watchSeed));
    Batch memory batch = XlnHanko.emptyBatch();
    batch.disputeStarts = new InitialDisputeProof[](1);
    batch.disputeStarts[0] = InitialDisputeProof(entity[1], 1, proposer, hash, body,
      body.watchSeed, sig, "", "", bytes32(0));
    assertTrue(_submit(0, batch));
  }

  function _assertStart(Vm.Log memory entry, ProofBody memory body) private pure {
    assertEq(entry.topics[0], keccak256("DisputeStarted(bytes32,bytes32,uint256,bool,bytes32,bytes32,bytes,bytes,bytes32,uint256,uint256,uint32,uint32,bytes)"));
    (, bytes32 hash,,,,,,,,, bytes memory encoded) = abi.decode(entry.data,
      (bool,bytes32,bytes32,bytes,bytes,bytes32,uint256,uint256,uint32,uint32,bytes));
    assertEq(encoded, abi.encode(body));
    assertEq(keccak256(encoded), hash);
  }

  function _assertFinal(Vm.Log memory entry, ProofBody memory body, bytes32 initialHash) private pure {
    assertEq(entry.topics[0], keccak256("DisputeFinalized(bytes32,bytes32,uint256,bytes32,bytes32,bytes,(bytes32,uint256,bool,bool,bytes32,bytes,bytes))"));
    (bytes32 hash, bytes32 evidenceHash, bytes memory encoded, DisputeFinalizationData memory data) =
      abi.decode(entry.data, (bytes32,bytes32,bytes,DisputeFinalizationData));
    assertEq(encoded.length, 0, "selected body already emitted");
    assertEq(hash, keccak256(abi.encode(body)));
    assertEq(data.initialProofbodyHash, initialHash);
    assertEq(data.finalNonce, 3);
    assertEq(data.sig.length, 0, "tower finalization emits effective empty signature");
    assertEq(keccak256(abi.encode(data.initialProofbodyHash, data.finalNonce,
      data.proposerIsLeft, data.startedByLeft, data.starterArgumentsHash,
      keccak256(data.otherArguments), keccak256(data.sig))), evidenceHash);
  }

  function test_startCounterAndTowerFinalizeEmitCompleteHashVerifiedBodies() public {
    ProofBody memory initial = _body(0);
    ProofBody memory newer = _body(1);
    vm.recordLogs();
    _start(initial);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    _assertStart(logs[0], initial);
    bool proposer = entity[0] < entity[1];
    bytes32 newerHash = keccak256(abi.encode(newer));
    FinalDisputeProof memory params = FinalDisputeProof(entity[0], 1, 3, proposer,
      keccak256(abi.encode(initial)), newer, "", "", _hanko(0, XlnHanko.disputeProofHash(
        address(dep), XlnHanko.accountKey(entity[0], entity[1]), 3, proposer, newerHash, newer.watchSeed)),
      entity[0] < entity[1], false);
    bytes memory owner = _hanko(1, dep.computeWatchtowerCounterDisputeHash(address(this),
      entity[1], entity[0], 3, newerHash, 10, 1));
    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS - 10);
    vm.recordLogs();
    assertTrue(dep.watchtowerCounterDispute(entity[1], params, 10, 1, owner));
    logs = vm.getRecordedLogs();
    assertEq(logs[0].topics[0], keccak256("CounterDisputeRegistered(bytes32,bytes32,uint256,bool,bytes32,bytes)"));
    (, bytes32 hash, bytes memory encoded) = abi.decode(logs[0].data, (bool,bytes32,bytes));
    assertEq(encoded, abi.encode(newer));
    assertEq(keccak256(encoded), hash);
    vm.warp(block.timestamp + 10);
    vm.recordLogs();
    assertTrue(dep.watchtowerCounterDispute(entity[1], params, 10, 1, owner));
    logs = vm.getRecordedLogs();
    _assertFinal(logs[logs.length - 2], newer, keccak256(abi.encode(initial)));
  }
  function test_signedFinalizationEmitsPreviouslyUnseenBody() public {
    ProofBody memory initial = _body(0);
    ProofBody memory newer = _body(1);
    _start(initial);
    bool proposer = entity[0] < entity[1];
    bytes32 hash = keccak256(abi.encode(newer));
    Batch memory batch = XlnHanko.emptyBatch();
    batch.disputeFinalizations = new FinalDisputeProof[](1);
    batch.disputeFinalizations[0] = FinalDisputeProof(entity[0], 1, 3, proposer,
      keccak256(abi.encode(initial)), newer, "", "", _hanko(0, XlnHanko.disputeProofHash(
        address(dep), XlnHanko.accountKey(entity[0], entity[1]), 3, proposer, hash, newer.watchSeed)),
      entity[0] < entity[1], false);
    vm.recordLogs();
    assertTrue(_submit(1, batch));
    Vm.Log[] memory logs = vm.getRecordedLogs();
    (bytes32 emittedHash,, bytes memory encoded,) = abi.decode(logs[logs.length - 2].data,
      (bytes32,bytes32,bytes,DisputeFinalizationData));
    assertEq(encoded, abi.encode(newer));
    assertEq(keccak256(encoded), emittedHash);
  }

  function test_timeoutFinalizationReusesStartedBody() public {
    ProofBody memory initial = _body(0);
    _start(initial);
    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
    Batch memory batch = XlnHanko.emptyBatch();
    batch.disputeFinalizations = new FinalDisputeProof[](1);
    bytes32 hash = keccak256(abi.encode(initial));
    batch.disputeFinalizations[0] = FinalDisputeProof(entity[0], 1, 1, entity[1] < entity[0],
      hash, initial, "", "", "", entity[0] < entity[1], false);
    vm.recordLogs();
    assertTrue(_submit(1, batch));
    Vm.Log[] memory logs = vm.getRecordedLogs();
    (bytes32 emittedHash,, bytes memory encoded,) = abi.decode(logs[logs.length - 2].data,
      (bytes32,bytes32,bytes,DisputeFinalizationData));
    assertEq(encoded.length, 0);
    assertEq(emittedHash, hash);
  }

  function test_counterReusingSelectedBodyEmitsOnlyItsHash() public {
    ProofBody memory initial = _body(0);
    ProofBody memory newer = _body(1);
    _start(initial);
    bytes32 hash = keccak256(abi.encode(newer));
    bool proposer = entity[0] < entity[1];
    for (uint256 nonce = 3; nonce <= 4; nonce++) {
      Batch memory batch = XlnHanko.emptyBatch();
      batch.counterDisputes = new CounterDisputeProof[](1);
      batch.counterDisputes[0] = CounterDisputeProof(entity[0], 1, keccak256(abi.encode(initial)),
        nonce, proposer, newer, _hanko(0, XlnHanko.disputeProofHash(address(dep),
          XlnHanko.accountKey(entity[0], entity[1]), nonce, proposer, hash, newer.watchSeed)));
      vm.recordLogs();
      assertTrue(_submit(1, batch));
      Vm.Log[] memory logs = vm.getRecordedLogs();
      (,bytes32 emittedHash,bytes memory encoded) = abi.decode(logs[0].data, (bool,bytes32,bytes));
      assertEq(emittedHash, hash);
      assertEq(encoded, nonce == 3 ? abi.encode(newer) : bytes(""));
    }
  }

}
