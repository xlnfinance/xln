// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./HashLadder.sol";

/* 
Subcontracts - Programmable Delta Transformers
  function applyBatch(int[] memory deltas, bytes calldata encodedBatch,
                      bytes calldata leftArguments, bytes calldata rightArguments)
    → int[] memory newDeltas

  What you can do:
  - HTLCs (conditional payments based on secret reveal)
  - Atomic swaps (exchange token A for token B, all-or-nothing)
  - Any programmable state transition within bilateral account

  First in history: Lightning only has HTLCs hardcoded. You're generalizing it - arbitrary logic can transform delta arrays. The applySwap() function (line
   105) shows fillRatio execution (0-100% fill of limit order).

  This is DeFi within bilateral accounts. Genuinely new.
  */
contract DeltaTransformer {
  error InvalidDeltaIndex();
  error AlreadyRevealed();
  mapping(bytes32 => uint) public hashToBlock;
  mapping(bytes32 => uint) public hashToTimestamp;
  mapping(bytes32 => bool) public hashRevealed;
  uint256 constant MAX_FILL_RATIO = type(uint16).max;

  struct Batch {
    Payment[] payment;
    Swap[] swap;
    Pull[] pull;
  }

  // actual subcontract structs
  struct Payment {
    uint deltaIndex;
    int amount;
    uint revealedUntilTimestamp;
    bytes32 hash;
  }

  struct Swap {
    bool ownerIsLeft;

    uint addDeltaIndex;
    uint addAmount;

    uint subDeltaIndex;
    uint subAmount;
  }

  struct Pull {
    uint deltaIndex;
    int amount;
    uint16 claimedRatio;
    uint revealedUntilTimestamp;
    bytes32 fullHash;
    bytes32 partialRoot;
  }

  struct Arguments {
    uint16[] fillRatios;
    bytes32[] secrets;
    bytes[] pulls;
  }

  function encodeBatch (Batch memory b) public pure returns (bytes memory) {
    return abi.encode(b);
  }



  // applies arbitrary changes to deltas
  function applyBatch(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments
  ) public view returns (int[] memory) {
    return _applyBatch(deltas, encodedBatch, leftArguments, rightArguments, block.timestamp, block.timestamp);
  }

  function supportsArgumentTimestamps() external pure returns (bool) {
    return true;
  }

  function applyBatchWithArgumentTimestamps(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments,
    uint leftArgumentsTimestamp,
    uint rightArgumentsTimestamp
  ) external view returns (int[] memory) {
    return _applyBatch(deltas, encodedBatch, leftArguments, rightArguments, leftArgumentsTimestamp, rightArgumentsTimestamp);
  }

  function _applyBatch(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments,
    uint leftArgumentsTimestamp,
    uint rightArgumentsTimestamp
  ) private view returns (int[] memory) {
    // `encodedBatch` is part of the signed ProofBody. If it is malformed, the
    // signed state itself is invalid and the dispute must fail loudly.
    Batch memory decodedBatch = abi.decode(encodedBatch, (Batch));

    Arguments memory left = _decodeArguments(leftArguments);
    Arguments memory right = _decodeArguments(rightArguments);
    
    for (uint i = 0; i < decodedBatch.payment.length; i++) {
      applyPayment(deltas, decodedBatch.payment[i], left.secrets, right.secrets, leftArgumentsTimestamp, rightArgumentsTimestamp);
    }

    uint leftSwaps = 0;
    uint rightSwaps = 0;
    for (uint i = 0; i < decodedBatch.swap.length; i++) {
      Swap memory swap = decodedBatch.swap[i];

      // Counterparty chooses fill ratio; the maker cannot fill its own order in
      // dispute calldata. A malformed/missing counterparty argument is simply a
      // 0% fill, not a revert. Otherwise an adversary could send garbage args
      // and block the honest side from finalizing any other claim in the same
      // account dispute.
      // Left-owned swap -> use right arguments; Right-owned swap -> use left arguments.
      uint16 fillRatio = 0;
      if (swap.ownerIsLeft) {
        if (rightSwaps < right.fillRatios.length) fillRatio = right.fillRatios[rightSwaps];
        rightSwaps++;
      } else {
        if (leftSwaps < left.fillRatios.length) fillRatio = left.fillRatios[leftSwaps];
        leftSwaps++;
      }

      applySwap(deltas, swap, fillRatio);
      //logDeltas("Deltas after swap", deltas);
    }

    uint leftPulls = 0;
    uint rightPulls = 0;
    for (uint i = 0; i < decodedBatch.pull.length; i++) {
      Pull memory pull = decodedBatch.pull[i];

      // Pull args must come from the beneficiary side:
      // positive amount credits left; negative amount credits right.
      // Invalid pull evidence is treated as no reveal. This is intentional:
      // arguments are adversarial evidence, while ProofBody is signed state.
      if (pull.amount >= 0) {
        bytes memory pullArg = leftPulls < left.pulls.length ? left.pulls[leftPulls] : bytes("");
        applyPull(deltas, pull, pullArg, leftArgumentsTimestamp);
        leftPulls++;
      } else {
        bytes memory pullArg = rightPulls < right.pulls.length ? right.pulls[rightPulls] : bytes("");
        applyPull(deltas, pull, pullArg, rightArgumentsTimestamp);
        rightPulls++;
      }
    }

    return deltas;
  }

  function decodeArgumentsStrict(bytes calldata encoded) external pure returns (Arguments memory) {
    return abi.decode(encoded, (Arguments));
  }

  function _emptyArguments() private pure returns (Arguments memory args) {
    args.fillRatios = new uint16[](0);
    args.secrets = new bytes32[](0);
    args.pulls = new bytes[](0);
    return args;
  }

  function _decodeArguments(bytes calldata encoded) private view returns (Arguments memory args) {
    if (encoded.length == 0) {
      return _emptyArguments();
    }

    // Dispute arguments are not trusted. They may be supplied by the party who
    // benefits from blocking finalization, so malformed evidence must degrade
    // to "no evidence". We deliberately use an external self-call because a
    // direct abi.decode revert cannot be caught inside Solidity. This keeps the
    // contract strict for signed ProofBody data and soft for adversarial args.
    try this.decodeArgumentsStrict(encoded) returns (Arguments memory decoded) {
      return decoded;
    } catch {
      return _emptyArguments();
    }
  }

  function applyPayment(
    int[] memory deltas,
    Payment memory payment,
    bytes32[] memory lSecrets,
    bytes32[] memory rSecrets,
    uint leftArgumentsTimestamp,
    uint rightArgumentsTimestamp
  ) private view {
    // Apply amount when the hash was revealed on chain or supplied in dispute
    // calldata before the side-specific argument timestamp. Argument timestamps
    // matter because the starter's evidence is frozen at disputeStart while the
    // finalizer's evidence is fresh at finalize time.
    uint revealedAt = hashToTimestamp[payment.hash];
    bool revealed = false;
    if (revealedAt != 0 && revealedAt <= payment.revealedUntilTimestamp) {
      revealed = true;
    }
    if (!revealed) {
      if (leftArgumentsTimestamp <= payment.revealedUntilTimestamp && matchesSecret(payment.hash, lSecrets)) {
        revealed = true;
      }
      if (!revealed && rightArgumentsTimestamp <= payment.revealedUntilTimestamp && matchesSecret(payment.hash, rSecrets)) {
        revealed = true;
      }
    }
    if (!revealed) return;
    if (payment.deltaIndex >= deltas.length) revert InvalidDeltaIndex();

    deltas[payment.deltaIndex] += payment.amount;
  }

  function matchesSecret(bytes32 hashlock, bytes32[] memory secrets) private pure returns (bool) {
    for (uint i = 0; i < secrets.length; i++) {
      if (keccak256(abi.encode(secrets[i])) == hashlock) {
        return true;
      }
    }
    return false;
  }

  function applySwap(int[] memory deltas, Swap memory swap, uint16 fillRatio) private pure {
    if (swap.addDeltaIndex >= deltas.length || swap.subDeltaIndex >= deltas.length) revert InvalidDeltaIndex();
    deltas[swap.addDeltaIndex] += int(swap.addAmount * fillRatio / MAX_FILL_RATIO);
    deltas[swap.subDeltaIndex] -= int(swap.subAmount * fillRatio / MAX_FILL_RATIO);
  }

  function applyPull(
    int[] memory deltas,
    Pull memory pull,
    bytes memory pullArg,
    uint argumentsTimestamp
  ) private pure {
    if (pull.deltaIndex >= deltas.length) revert InvalidDeltaIndex();

    uint16 fillRatio = verifiedPullFillRatio(pull, pullArg, argumentsTimestamp);
    if (fillRatio == 0 || fillRatio <= pull.claimedRatio) return;

    uint absAmount = pull.amount >= 0 ? uint(pull.amount) : uint(-pull.amount);
    uint newClaim = absAmount * uint(fillRatio) / MAX_FILL_RATIO;
    uint previousClaim = absAmount * uint(pull.claimedRatio) / MAX_FILL_RATIO;
    if (newClaim <= previousClaim) return;
    int applied = int(newClaim - previousClaim);
    if (pull.amount >= 0) {
      deltas[pull.deltaIndex] += applied;
    } else {
      deltas[pull.deltaIndex] -= applied;
    }
  }

  function verifiedPullFillRatio(
    Pull memory pull,
    bytes memory pullArg,
    uint argumentsTimestamp
  ) private pure returns (uint16) {
    if (pullArg.length == 0) return 0;
    if (argumentsTimestamp > pull.revealedUntilTimestamp) return 0;

    if (pullArg.length == 32) {
      bytes32 fullSecret;
      assembly ("memory-safe") {
        fullSecret := mload(add(pullArg, 0x20))
      }
      if (!HashLadder.verifyFull(pull.fullHash, fullSecret)) return 0;
      return type(uint16).max;
    }

    if (pullArg.length != 130) return 0;
    uint16 fillRatio = (uint16(uint8(pullArg[0])) << 8) | uint16(uint8(pullArg[1]));
    if (fillRatio == 0 || fillRatio == type(uint16).max) return 0;

    bytes32[4] memory reveals;
    assembly ("memory-safe") {
      let data := add(pullArg, 0x22)
      mstore(reveals, mload(data))
      mstore(add(reveals, 0x20), mload(add(data, 0x20)))
      mstore(add(reveals, 0x40), mload(add(data, 0x40)))
      mstore(add(reveals, 0x60), mload(add(data, 0x60)))
    }
    if (!HashLadder.verifyPartial(pull.partialRoot, fillRatio, reveals)) return 0;
    return fillRatio;
  }





  function revealSecret(bytes32 secret) public {
    bytes32 hash = keccak256(abi.encode(secret));
    if (hashRevealed[hash]) revert AlreadyRevealed();
    hashRevealed[hash] = true;
    hashToBlock[hash] = block.number;
    hashToTimestamp[hash] = block.timestamp;
  }
  
  // anyone can get gas refund by deleting very old revealed secrets
  function cleanSecret(bytes32 hash) public {
    if (block.number > 100000 && hashToBlock[hash] != 0 && hashToBlock[hash] < block.number - 100000){
      delete hashToBlock[hash];
    }
  }
}
