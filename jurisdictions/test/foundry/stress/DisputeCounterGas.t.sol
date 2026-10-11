// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {DisputeGasFixture} from "./DisputeGasAdmission.t.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/Types.sol";
import "../../../contracts/HashLadder.sol";
import {console} from "forge-std/Test.sol";

/// The selected newer state must retain the same exit budget as an initial proof.
contract DisputeCounterGasTest is DisputeGasFixture {
    // Skip 2 so adopting the signed branch differs from initial-nonce + 1.
    uint256 private constant COUNTER_NONCE = 3;

    function _account() private view returns (AccountInfo memory result) {
        (bool ok, bytes memory encoded) = address(dep)
            .staticcall(abi.encodeWithSignature("_accounts(bytes)", XlnHanko.accountKey(entity[0], entity[1])));
        require(ok, "account read failed");
        return abi.decode(encoded, (AccountInfo));
    }

    function _counterExercise(uint256 tokens, uint256 payments, uint256 swaps, uint256 pulls) private {
        (ProofBody memory initial,) = _body(1, 0, 0, 0, false);
        (ProofBody memory newer, bytes memory args) = _body(tokens, payments, swaps, pulls, true);
        bytes32 initialHash = keccak256(abi.encode(initial));
        bytes32 newerHash = keccak256(abi.encode(newer));
        assertNotEq(initialHash, newerHash, "counter replaces the economic state");
        bytes memory starter = args;
        if (maximalStarter) {
            starter = new bytes(64 * 1024);
            for (uint256 offset; offset < starter.length; offset += 32) {
                assembly ("memory-safe") { mstore(add(add(starter, 32), offset), not(0)) }
            }
            for (uint256 i; i < args.length; i++) {
                starter[i] = args[i];
            }
        }
        bool initialProposerIsLeft = entity[1] < entity[0];
        bool counterProposerIsLeft = !initialProposerIsLeft;
        bytes memory key = XlnHanko.accountKey(entity[0], entity[1]);
        Batch memory start = XlnHanko.emptyBatch();
        start.disputeStarts = new InitialDisputeProof[](1);
        start.disputeStarts[0] = InitialDisputeProof(
            entity[1],
            1,
            initialProposerIsLeft,
            initialHash,
            initial,
            initial.watchSeed,
            _hanko(
                1,
                XlnHanko.disputeProofHash(address(dep), key, 1, initialProposerIsLeft, initialHash, initial.watchSeed)
            ),
            "",
            starter,
            keccak256(abi.encode(COUNTER_NONCE, counterProposerIsLeft, newerHash))
        );
        console.log("start total conservative gas", _submitBudget(0, start));

        // Actor 0 starts with actor 1's old signature. Actor 1 counters with actor
        // 0's newer signature; the fresh outer batch certifies actor 1's authority.
        Batch memory counter = XlnHanko.emptyBatch();
        counter.counterDisputes = new CounterDisputeProof[](1);
        counter.counterDisputes[0] = CounterDisputeProof(
            entity[0],
            1,
            initialHash,
            COUNTER_NONCE,
            counterProposerIsLeft,
            newer,
            _hanko(
                0,
                XlnHanko.disputeProofHash(
                    address(dep), key, COUNTER_NONCE, counterProposerIsLeft, newerHash, newer.watchSeed
                )
            )
        );
        console.log("counter total conservative gas", _submitBudget(1, counter));
        AccountInfo memory selected = _account();
        assertEq(selected.disputeCounterNonce, COUNTER_NONCE);
        assertEq(selected.disputeCounterProofbodyHash, newerHash);

        if (pulls > 0) {
            Batch memory reveal = XlnHanko.emptyBatch();
            reveal.hashLadderRegistrations = new HashLadderRegistration[](pulls);
            uint256 beneficiary = entity[0] < entity[1] ? 0 : 1;
            for (uint256 i; i < pulls; i++) {
                (bytes32 fullHash, bytes32 root, HashLadderWitness memory witness) = _ladder(i);
                reveal.hashLadderRegistrations[i] =
                    HashLadderRegistration(entity[1 - beneficiary], false, fullHash, root, witness);
            }
            console.log("reveal total conservative gas", _submitBudget(beneficiary, reveal));
        }
        vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
        Batch memory finish = XlnHanko.emptyBatch();
        finish.disputeFinalizations = new FinalDisputeProof[](1);
        finish.disputeFinalizations[0] = FinalDisputeProof(
            entity[0],
            1,
            COUNTER_NONCE,
            counterProposerIsLeft,
            initialHash,
            newer,
            starter,
            args,
            "",
            entity[0] < entity[1],
            false
        );
        console.log("finalize total conservative gas", _submitBudget(1, finish));
        AccountInfo memory closed = _account();
        assertEq(closed.nonce, COUNTER_NONCE, "finalized the newer proof, not the initial one");
        assertEq(closed.disputeHash, bytes32(0));
        assertEq(closed.disputeCounterNonce, 0);
    }

    function test_budget5m_minimalSingleToken() public {
        _exercise(1, 0, 0, 0, false);
    }

    function test_budget5m_counterSingleToken() public {
        _counterExercise(1, 0, 0, 0);
    }

    function test_budget5m_counterWideColdDebts22() public {
        _counterExercise(22, 0, 0, 0);
    }

    function test_budget5m_counterPayments32MaxStarter() public {
        maximalStarter = true;
        chunkSize = 32;
        _counterExercise(7, 32, 0, 0);
    }

    function test_budget5m_counterMmFrontierMaxStarter() public {
        maximalStarter = true;
        _counterExercise(5, 0, 32, 18);
    }

    function testFuzz_budget5m_counterStockFrontier(uint8 tokenSeed, uint8 paymentSeed, uint8 swapSeed, uint8 pullSeed)
        public
    {
        uint256 tokens = bound(uint256(tokenSeed), 1, 10);
        uint256 payments = bound(uint256(paymentSeed), 0, 32);
        uint256 swaps = bound(uint256(swapSeed), 0, 32);
        uint256 pulls = bound(uint256(pullSeed), 0, 18);
        uint256 charge = 3_000_000 + tokens * 200_000 + (10_000 + 50_000 + tokens * 4_000) * (payments + swaps + pulls);
        vm.assume(charge <= BUDGET && payments + swaps + pulls <= 32);
        maximalStarter = true;
        chunkSize = 1;
        _counterExercise(tokens, payments, swaps, pulls);
    }
}
