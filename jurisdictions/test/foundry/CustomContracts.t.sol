// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import {console} from "forge-std/Test.sol";
import "../../contracts/Types.sol";

/// Real solc-0.8.25 wallet artifacts, real Account/Depository and Hanko path.
contract CustomContractsTest is XlnFixture {
  bytes internal initcode;
  uint256 internal left;
  uint256 internal right;

  function setUp() public {
    _deployXln();
    initcode = vm.parseJsonBytes(vm.readFile("test/fixtures/custom-contracts.json"), ".conditional-payment.initcode");
    left = entity[0] < entity[1] ? 0 : 1; right = 1 - left;
    dep.mintToReserve(entity[left], 1, 2000);
    Batch memory funding = XlnHanko.emptyBatch();
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount(entity[right], 1000);
    funding.reserveToCollateral = new ReserveToCollateral[](1);
    funding.reserveToCollateral[0] = ReserveToCollateral(1, entity[left], pairs);
    _submit(left, funding);
  }

  function _proof() internal view returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("custom-contract");
    pb.leftResponseSeconds = 50; pb.rightResponseSeconds = 50;
    pb.offdeltas = new Int512[](1); pb.tokenIds = new uint256[](1); pb.tokenIds[0] = 1;
    pb.transformers = new TransformerClause[](1);
    Allowance[] memory allowances = new Allowance[](1); allowances[0] = Allowance(0, 100, 0);
    pb.transformers[0] = TransformerClause(deltaTransformer.customTransformerAddress(keccak256(initcode)), abi.encode(uint256(1), uint256(100), true), allowances);
  }
  function _start(ProofBody memory pb) internal {
    bytes32 hash = keccak256(abi.encode(pb));
    bytes32 signedHash = XlnHanko.disputeProofHash(address(dep), XlnHanko.accountKey(entity[left], entity[right]), 1, false, hash, pb.watchSeed);
    Batch memory batch = XlnHanko.emptyBatch();
    batch.disputeStarts = new InitialDisputeProof[](1);
    batch.disputeStarts[0] = InitialDisputeProof(entity[right], 1, false, hash, pb, pb.watchSeed, _hanko(right, signedHash), "", "", bytes32(0));
    _submit(left, batch);
  }
  function _finalize(ProofBody memory pb, bool execute) internal {
    bytes[] memory arguments = new bytes[](1); arguments[0] = abi.encode(execute);
    Batch memory batch = XlnHanko.emptyBatch();
    batch.disputeFinalizations = new FinalDisputeProof[](1);
    batch.disputeFinalizations[0] = FinalDisputeProof(entity[left], 1, 1, false, keccak256(abi.encode(pb)), pb, "", abi.encode(arguments), "", true, false);
    _submit(right, batch);
  }

  function test_counterfactualDeployThenDisputePaysAndConservesValue() public {
    ProofBody memory pb = _proof(); address predicted = pb.transformers[0].transformerAddress;
    assertEq(predicted.code.length, 0); _start(pb);
    uint256 beforeDeploy = gasleft();
    assertEq(deltaTransformer.deployCustomTransformer(initcode), predicted);
    uint256 deployGas = beforeDeploy - gasleft();
    assertGt(predicted.code.length, 0);
    assertEq(deltaTransformer.deployCustomTransformer(initcode), predicted);
    uint256 beforeFinalize = gasleft(); _finalize(pb, true);
    uint256 finalizeGas = beforeFinalize - gasleft();
    assertEq(dep._reserves(entity[left], 1), 1900); assertEq(dep._reserves(entity[right], 1), 100);
    (uint256 collateral,) = dep._collaterals(XlnHanko.accountKey(entity[left], entity[right]), 1);
    assertEq(collateral, 0); assertLt(deployGas + finalizeGas, 6_000_000);
    console.log("custom deploy execution gas", deployGas); console.log("custom finalization execution gas", finalizeGas);
  }
  function test_falseArgumentDoesNotPay() public {
    ProofBody memory pb = _proof(); _start(pb);
    deltaTransformer.deployCustomTransformer(initcode); _finalize(pb, false);
    assertEq(dep._reserves(entity[left], 1), 2000); assertEq(dep._reserves(entity[right], 1), 0);
  }
  function test_missingCodeFailsStrictlyThenSameSignedProofSucceeds() public {
    ProofBody memory pb = _proof(); _start(pb);
    vm.expectRevert(); this.finalizeAttempt(pb, true);
    deltaTransformer.deployCustomTransformer(initcode); _finalize(pb, true);
    assertEq(dep._reserves(entity[right], 1), 100);
  }
  function finalizeAttempt(ProofBody memory pb, bool execute) external {
    require(msg.sender == address(this));
    _finalize(pb, execute);
  }
}
