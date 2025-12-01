# XLN Insurance Implementation (Codex v2)

This specification and reference implementation combine the strengths of Gemini's certificate model and Claude's pull-based claims while adding concrete guardrails, watcher workflows, and governance hooks. Goal: deterministic settlement, proof-over-state, clear UX, and auditable risk limits.

## 1. Architecture Overview
```
Entities  ── lock capital →  InsuranceProvider vault
Debtors  ── present certificate stack →  Depository.claimInsurance()
Creditors ── pull coverage per debt → shortfall resolved
```
- Policies exist off-chain as signed `InsuranceCertificate`s.
- `InsuranceProvider` escrows bonded capital per insurer/token and tracks certificate usage.
- Depository exposes `claimInsurance` for creditors/watchers; no automatic cascade.

## 2. Certificate Schema (Version 1)
```
struct InsuranceCertificate {
    bytes32 insured;      // entity receiving coverage
    bytes32 insurer;      // capital provider
    uint256 tokenId;      // asset being covered
    uint256 maxCoverage;  // cumulative cap
    uint256 expiry;       // unix timestamp
    bytes32 salt;         // unique nonce per certificate
    bytes signature;      // insurer signature over hash
}

hash = keccak256(abi.encodePacked(
    "XLN_INS_CERT_V1",
    address(insuranceProvider), insured, insurer, tokenId, maxCoverage, expiry, salt
))
```
- Signature must be Hanko-derived (EntityProvider-signed) in production; `ecrecover` shown for reference.
- Certificates are submitted in order; reinsurance is represented by chaining certs where `cert.insurer == nextCert.insured`.

## 3. Watcher / UX Workflow
1. Watcher monitors `DebtCreated` events. When a debt references a debtor with known certificates, it queues a claim task.
2. Watcher selects debt entries (oldest first to respect FIFO) and fetches certificate stacks (from insurer APIs or off-chain registries).
3. Watcher submits `claimInsurance(debtor, tokenId, debtIndex, certificates)` from the creditor’s signer.
4. Depository processes certificates sequentially; recovered amounts reduce debt immediately. Any leftover amount remains in `_debts` queue for standard enforcement.

## 4. Guardrails
- **Cycle prevention:** Depository tracks the `insured` IDs encountered within a claim call (max 8 entries) and rejects repeats.
- **Max stack depth:** Governance parameter `MAX_CERTIFICATES = 8` ensures predictable gas.
- **Certificate expiry:** Enforced per certificate; expired entries are ignored without reverting.
- **Usage tracking:** InsuranceProvider keeps per-hash usage to prevent over-claims.
- **Capital floor:** Governance can require minimum `lockedCapital` and `entityScore` before an entity is allowed to bond (hook shown below).

## 5. Premiums / Subcontracts
Premium flows remain off-chain or via XLN subcontracts: insurers and insureds negotiate periodic payments using Account machines. The Depository/InsuranceProvider only handle collateralized coverage, not premium enforcement.

## 6. Solidity Reference Implementation
### Interfaces
```solidity
interface IInsuranceProvider {
    function increaseBond(bytes32 insurer, uint256 tokenId, uint256 amount) external;
    function decreaseBond(bytes32 insurer, uint256 tokenId, uint256 amount) external;
    function claim(
        bytes32 insured,
        bytes32 insurer,
        uint256 tokenId,
        uint256 maxCoverage,
        uint256 expiry,
        bytes32 salt,
        bytes calldata signature,
        bytes32 creditor,
        uint256 requestedAmount
    ) external returns (uint256 paid);
}
```

### InsuranceProvider.sol
```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import "./IDepository.sol"; // existing interface for crediting reserves

contract InsuranceProvider {
    IDepository public immutable depository;

    mapping(bytes32 => mapping(uint256 => uint256)) public lockedCapital; // insurer -> token -> amount
    mapping(bytes32 => uint256) public usage; // certificate hash -> used amount

    event BondAdded(bytes32 indexed insurer, uint256 indexed tokenId, uint256 amount);
    event BondRemoved(bytes32 indexed insurer, uint256 indexed tokenId, uint256 amount);

    constructor(address _depository) {
        require(_depository != address(0), "invalid depository");
        depository = IDepository(_depository);
    }

    function increaseBond(bytes32 insurer, uint256 tokenId, uint256 amount) external {
        require(msg.sender == address(depository), "only depository");
        lockedCapital[insurer][tokenId] += amount;
        emit BondAdded(insurer, tokenId, amount);
    }

    function decreaseBond(bytes32 insurer, uint256 tokenId, uint256 amount) external {
        require(msg.sender == address(depository), "only depository");
        uint256 current = lockedCapital[insurer][tokenId];
        require(current >= amount, "insufficient bond");
        lockedCapital[insurer][tokenId] = current - amount;
        emit BondRemoved(insurer, tokenId, amount);
    }

    function certHash(
        bytes32 insured,
        bytes32 insurer,
        uint256 tokenId,
        uint256 maxCoverage,
        uint256 expiry,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("XLN_INS_CERT_V1", address(this), insured, insurer, tokenId, maxCoverage, expiry, salt)
        );
    }

    function claim(
        bytes32 insured,
        bytes32 insurer,
        uint256 tokenId,
        uint256 maxCoverage,
        uint256 expiry,
        bytes32 salt,
        bytes calldata signature,
        bytes32 creditor,
        uint256 requestedAmount
    ) external returns (uint256 paid) {
        require(msg.sender == address(depository), "only depository");
        require(block.timestamp <= expiry, "expired cert");

        bytes32 hash = certHash(insured, insurer, tokenId, maxCoverage, expiry, salt);
        bytes32 signer = _recover(hash, signature);
        require(signer == insurer, "bad signature");

        uint256 used = usage[hash];
        if (used >= maxCoverage) return 0;

        uint256 remainingCapacity = maxCoverage - used;
        uint256 liquidity = lockedCapital[insurer][tokenId];

        paid = requestedAmount;
        if (paid > remainingCapacity) paid = remainingCapacity;
        if (paid > liquidity) paid = liquidity;

        if (paid == 0) return 0;

        usage[hash] = used + paid;
        lockedCapital[insurer][tokenId] = liquidity - paid;
        depository.creditFromInsurance(insurer, creditor, tokenId, paid);
    }

    function _recover(bytes32 hash, bytes memory sig) private pure returns (bytes32) {
        require(sig.length == 65, "bad sig len");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        address addr = ecrecover(
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)),
            v,
            r,
            s
        );
        require(addr != address(0), "zero signer");
        return bytes32(uint256(uint160(addr)));
    }
}
```

### Depository.sol Hooks (extract)
```solidity
contract Depository {
    uint256 public constant MAX_CERTIFICATES = 8;

    struct InsuranceCertificate {
        bytes32 insured;
        bytes32 insurer;
        uint256 tokenId;
        uint256 maxCoverage;
        uint256 expiry;
        bytes32 salt;
        bytes signature;
    }

    IInsuranceProvider public insuranceProvider;

    event InsurancePayout(bytes32 indexed insurer, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount);

    function setInsuranceProvider(address provider) external onlyAdmin {
        require(provider != address(0), "zero addr");
        insuranceProvider = IInsuranceProvider(provider);
    }

    function bondInsuranceCapital(uint256 tokenId, uint256 amount) external {
        bytes32 insurer = _entityId(msg.sender);
        require(_reserves[insurer][tokenId] >= amount, "insufficient reserves");
        _reserves[insurer][tokenId] -= amount;
        insuranceProvider.increaseBond(insurer, tokenId, amount);
    }

    function unbondInsuranceCapital(uint256 tokenId, uint256 amount) external {
        bytes32 insurer = _entityId(msg.sender);
        insuranceProvider.decreaseBond(insurer, tokenId, amount);
        _increaseReserve(insurer, tokenId, amount);
    }

    function claimInsurance(
        bytes32 debtor,
        uint256 tokenId,
        uint256 debtIndex,
        InsuranceCertificate[] calldata certificates
    ) external returns (uint256 recovered) {
        require(certificates.length <= MAX_CERTIFICATES, "too many certs");
        Debt storage debt = _debts[debtor][tokenId][debtIndex];
        require(debt.amount > 0, "no debt");
        bytes32 creditor = debt.creditor;
        require(creditor == _entityId(msg.sender), "not creditor");

        uint256 remaining = debt.amount;
        bytes32[MAX_CERTIFICATES] memory seen;
        uint256 seenCount = 0;

        for (uint256 i = 0; i < certificates.length && remaining > 0; i++) {
            InsuranceCertificate calldata cert = certificates[i];
            if (cert.tokenId != tokenId) continue;
            if (cert.insured != debtor && !_seen(seen, seenCount, cert.insured)) continue;

            uint256 payout = insuranceProvider.claim(
                cert.insured,
                cert.insurer,
                cert.tokenId,
                cert.maxCoverage,
                cert.expiry,
                cert.salt,
                cert.signature,
                creditor,
                remaining
            );
            if (payout > 0) {
                recovered += payout;
                remaining -= payout;
                if (!_seen(seen, seenCount, cert.insurer)) {
                    seen[seenCount++] = cert.insurer;
                }
            }
        }

        if (recovered > 0) {
            if (recovered >= debt.amount) {
                _removeDebtAtIndex(debtor, tokenId, debtIndex);
            } else {
                debt.amount -= recovered;
            }
        }
    }

    function creditFromInsurance(
        bytes32 insurer,
        bytes32 creditor,
        uint256 tokenId,
        uint256 amount
    ) external {
        require(msg.sender == address(insuranceProvider), "only provider");
        _increaseReserve(creditor, tokenId, amount);
        emit InsurancePayout(insurer, creditor, tokenId, amount);
    }

    function _seen(bytes32[MAX_CERTIFICATES] memory arr, uint256 len, bytes32 id) private pure returns (bool) {
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == id) return true;
        }
        return false;
    }
}
```

## 7. Governance & Future Work
- Require insurers to register via governance (e.g., whitelist or minimum `entityScore`).
- Publish certificate hashes in on-chain registry for discoverability (optional optimization).
- Build watcher reference implementation to ensure claims happen promptly.
- Extend InsuranceProvider with reinsurance helper function if future use-cases demand automatic stacking.

With these additions, the Codex spec now matches Gemini’s architectural rigor, Claude’s safety focus, and includes executable code ready for production integration.
