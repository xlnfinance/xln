// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The Depository's hash-ladder reveal registry. The transformer reads
/// it through msg.sender: applyBatch only ever runs (via Account's DELEGATECALL
/// chain) with the settling Depository as the immediate caller, so the registry
/// read is always scoped to the jurisdiction that owns the disputed account.
interface IHashLadderRevealRegistry {
  function getHashLadderReveal(
    bytes32 ownerEntity,
    bytes32 counterpartyEntity,
    bytes32 ladderHash,
    bool targetRole
  )
    external
    view
    returns (uint16 fillRatio, uint256 revealedAt);
}

/* 
Subcontracts - Programmable Delta Transformers
  function applyBatch(int[] memory deltas, uint[] memory tokenIds,
                      bytes calldata encodedBatch, bytes calldata leftArguments,
                      bytes calldata rightArguments, uint leftArgumentsTimestamp,
                      uint rightArgumentsTimestamp)
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
  error ContextLengthMismatch();
  error PullRevealWindowActive(uint256 disputeTimeout);
  error PullRevealRegistryUnavailable(address caller);
  error InvalidPullAmount();
  // Sole payment-secret evidence store. `hashToTimestamp[hash] != 0` means
  // revealed; `revealedAt` is the first-seen block.timestamp (sticky).
  // Former hashToBlock / hashRevealed / cleanSecret were a closed dead set —
  // dispute resolution only reads this mapping.
  mapping(bytes32 => uint) public hashToTimestamp;
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
    // Settlement clock is dispute-relative, not a sealed route deadline.
    // Market/route expiry is not settlement authority — deleted.
    bytes32 fullHash;
    bytes32 partialRoot;
    // Signed semantic role. Source is cryptographically single-shot; Target
    // ports the public Source witness and may monotonically replace its record.
    bool targetRole;
  }

  // Dispute arguments carry only same-jurisdiction evidence. Pulls (cross-j)
  // are deliberately absent: their settlement reads the Depository reveal
  // registry, so no calldata can assert a cross-j fill ratio.
  struct Arguments {
    uint16[] fillRatios;
    bytes32[] secrets;
  }

  function encodeBatch (Batch memory b) public pure returns (bytes memory) {
    return abi.encode(b);
  }

  /// @notice Return whether this exact signed canonical batch needs the
  /// bilateral reveal window.
  /// @dev Only Pull reads evidence that may arrive after disputeStart. Payment
  /// secrets and swap arguments are already supplied by the finalizer, so
  /// delaying a pull-free counter-proof adds no safety and only harms liveness.
  /// Decoding is deliberately strict: malformed signed executable state must
  /// fail the dispute, never be reclassified as pull-free.
  function containsPull(bytes calldata encodedBatch) external pure returns (bool) {
    Batch memory decodedBatch = abi.decode(encodedBatch, (Batch));
    return decodedBatch.pull.length != 0;
  }

  /// @notice Strict decoder used through a gas-capped STATICCALL by Account.
  /// @dev Malformed dynamic evidence is converted to an empty argument list by
  /// Account, while an insufficient caller gas budget remains a hard failure.
  /// Hosting this pure ABI boundary here keeps the Depository below EIP-170
  /// without creating a second decoder or weakening transformer execution.
  function decodeTransformerArgumentListStrict(bytes calldata encoded)
    external pure returns (bytes[] memory)
  {
    return abi.decode(encoded, (bytes[]));
  }



  // applies arbitrary changes to deltas
  /// @notice Canonical transformer boundary used by Depository.
  /// @dev tokenIds are aligned 1:1 with deltas. Chain and Depository identity
  ///      are intentionally not duplicated in calldata; a transformer that
  ///      needs token metadata can read the calling Depository registry.
  function applyBatch(
    int[] calldata deltas,
    uint[] calldata tokenIds,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments,
    uint leftArgumentsTimestamp,
    uint rightArgumentsTimestamp,
    bytes32 leftEntity,
    bytes32 rightEntity,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  ) external view returns (int[] memory) {
    if (tokenIds.length != deltas.length) revert ContextLengthMismatch();
    return _applyBatch(
      deltas,
      encodedBatch,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp,
      rightArgumentsTimestamp,
      leftEntity,
      rightEntity,
      disputeStartTimestamp,
      disputeTimeout,
      leftResponseSeconds,
      rightResponseSeconds
    );
  }

  function _applyBatch(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments,
    uint leftArgumentsTimestamp,
    uint rightArgumentsTimestamp,
    bytes32 leftEntity,
    bytes32 rightEntity,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  ) private view returns (int[] memory) {
    // A clause failure is fatal to the whole finalization: the ProofBody is
    // signed executable state, so malformed data, a revert, OOG, or malformed
    // output must roll back the processBatch transaction and keep the dispute
    // active. Only the dynamic argument WRAPPER soft-decodes to empty.
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

    for (uint i = 0; i < decodedBatch.pull.length; i++) {
      applyPull(
        deltas,
        decodedBatch.pull[i],
        leftEntity,
        rightEntity,
        disputeStartTimestamp,
        disputeTimeout,
        leftResponseSeconds,
        rightResponseSeconds
      );
    }

    return deltas;
  }

  function decodeArgumentsStrict(bytes calldata encoded) external pure returns (Arguments memory) {
    return abi.decode(encoded, (Arguments));
  }

  function _emptyArguments() private pure returns (Arguments memory args) {
    args.fillRatios = new uint16[](0);
    args.secrets = new bytes32[](0);
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
    int give = int(swap.addAmount * fillRatio / MAX_FILL_RATIO);
    int want = int(swap.subAmount * fillRatio / MAX_FILL_RATIO);
    // Delta is LEFT's allocation. A left maker gives the give token (negative)
    // and receives the want token (positive); a right maker is the inverse.
    if (swap.ownerIsLeft) {
      deltas[swap.addDeltaIndex] -= give;
      deltas[swap.subDeltaIndex] += want;
    } else {
      deltas[swap.addDeltaIndex] += give;
      deltas[swap.subDeltaIndex] -= want;
    }
  }

  function applyPull(
    int[] memory deltas,
    Pull memory pull,
    bytes32 leftEntity,
    bytes32 rightEntity,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  ) private view {
    if (pull.deltaIndex >= deltas.length) revert InvalidDeltaIndex();
    if (pull.amount == 0) revert InvalidPullAmount();

    // Canon (owner 2026-08): dispute period T is jurisdiction SECONDS from the
    // start of THIS dispute. Finalizing before T lets a hub settle one leg at 0
    // then reveal on the other — asymmetric theft.
    //
    // Each role uses its own dispute start plus its beneficiary-side window.
    // The left+right sum is exclusively the finalization barrier.
    // Why not a sealed route deadline: kills honest late disputes or lets the
    // hub pick open time vs a frozen clock. Why seconds not blocks: chains have
    // different/changing blockTimes.
    if (
      disputeStartTimestamp == 0 ||
      disputeTimeout < disputeStartTimestamp ||
      disputeTimeout != disputeStartTimestamp + uint256(leftResponseSeconds) + uint256(rightResponseSeconds)
    ) {
      revert PullRevealWindowActive(disputeTimeout);
    }
    if (block.timestamp < disputeTimeout) {
      revert PullRevealWindowActive(disputeTimeout);
    }

    // Pulls settle exclusively from independent public registry evidence,
    // never dispute calldata. Signed left/right entities derive the exact
    // bilateral Account namespace; the signed Pull then supplies beneficiary,
    // ladder and role. A record published under a false counterparty is inert.
    bytes32 beneficiary = pull.amount >= 0 ? leftEntity : rightEntity;
    bytes32 counterparty = beneficiary == leftEntity ? rightEntity : leftEntity;
    bytes32 ladderHash = keccak256(abi.encodePacked(pull.fullHash, pull.partialRoot));
    (bool registryOk, bytes memory registryData) = msg.sender.staticcall(
      abi.encodeWithSelector(
        IHashLadderRevealRegistry.getHashLadderReveal.selector,
        beneficiary,
        counterparty,
        ladderHash,
        pull.targetRole
      )
    );
    if (!registryOk || registryData.length != 64) {
      revert PullRevealRegistryUnavailable(msg.sender);
    }
    (uint16 ratio, uint256 revealedAt) = abi.decode(registryData, (uint16, uint256));
    uint32 beneficiaryWindow = beneficiary == leftEntity
      ? leftResponseSeconds
      : rightResponseSeconds;
    // Source and Target are independent Account clocks on different chains.
    // Each role opens immediately with its own dispute and receives exactly
    // the beneficiary's bilaterally signed response window. Finalization still
    // waits the full left+right sum above so neither side can settle early.
    uint256 revealStart = disputeStartTimestamp;
    uint256 revealDeadline = disputeStartTimestamp + uint256(beneficiaryWindow);
    // Both bounds are consensus-critical. The lower bound prevents a record
    // from an older dispute (after accidental ladder reuse) from becoming
    // active in this dispute without a fresh observable registry event.
    uint16 fillRatio = (
      revealedAt >= revealStart && revealedAt <= revealDeadline
    ) ? ratio : 0;

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





  function revealSecret(bytes32 secret) public {
    bytes32 hash = keccak256(abi.encode(secret));
    // Exact retries are expected after response loss or crash recovery. A
    // revert here would abort the whole Depository batch before its dispute
    // finalizations execute. Returning preserves the first-seen evidence and
    // makes delivery idempotent; a different preimage has a different hash.
    // Never clear hashToTimestamp: that would allow a re-reveal with a fresh
    // timestamp and rewrite revealedAt for still-live disputes.
    if (hashToTimestamp[hash] != 0) return;
    hashToTimestamp[hash] = block.timestamp;
  }
}
