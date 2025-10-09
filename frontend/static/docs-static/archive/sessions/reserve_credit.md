# XLN: Reserve Credit System

## Core Concept

XLN introduces a novel approach to payment channels through its Reserve Credit System, which combines collateral-based security with credit-based flexibility. This system enables efficient, secure, and scalable off-chain transactions while maintaining strong economic guarantees.

## Key Components

### 1. Reserves
- Personal token holdings stored in the contract
- Can be converted to channel collateral
- Acts as a security deposit for credit operations
- Automatically used to settle debts when channels are closed

### 2. Collateral
- Locked tokens in a channel between two parties
- Provides immediate liquidity for transactions
- Can be split between parties based on channel state
- Protects against malicious behavior

### 3. Credit Limits
- Allows transactions beyond collateral amounts
- Each party can extend credit to their peer
- Credit limits are set independently by each party
- Enables larger transaction volumes with less locked capital

### 4. Channel State
The channel state is tracked through several key metrics:
- `ondelta`: Permanent state changes (e.g., deposits)
- `offdelta`: Temporary state changes (e.g., payments)
- `leftCreditLimit` & `rightCreditLimit`: Credit extended by each party
- `collateral`: Total locked tokens in the channel

## How It Works

1. **Channel Setup**
   - Users deposit tokens into their reserve
   - Convert reserve to channel collateral
   - Set credit limits for their counterparty

2. **Transaction Flow**
   - Payments first use available collateral
   - When collateral is exhausted, credit is used
   - Credit usage is tracked via deltas
   - Total capacity = collateral + own credit + peer credit

3. **Settlement Process**
   - Channels can be closed cooperatively or through dispute
   - Final state determines collateral distribution
   - Credit used is settled from reserves
   - Unpaid credit becomes debt

4. **Debt Handling**
   - Debts must be paid before new reserve operations
   - Automatic debt settlement from available reserves
   - FIFO debt queue system
   - Active debt tracking per entity

## Advantages

1. **Capital Efficiency**
   - Less capital locked in channels
   - Credit enables higher transaction volumes
   - Flexible collateral management

2. **Security**
   - Collateral-backed transactions
   - Automatic debt settlement
   - Dispute resolution mechanism

3. **Scalability**
   - Off-chain state management
   - Batched settlement options
   - Efficient multi-token support

## Technical Implementation

The system is implemented through smart contracts and off-chain state management:

```solidity
struct ChannelCollateral {
    uint collateral;
    int ondelta;
}

struct Debt {
    uint amount;
    address creditor;
}
```

Channel capacity is calculated as:
```
totalCapacity = collateral + ownCreditLimit + peerCreditLimit
inCapacity = inOwnCredit + inCollateral + inPeerCredit - inAllowance
outCapacity = outPeerCredit + outCollateral + outOwnCredit - outAllowance
```

## Future Directions

1. **Credit Scoring**
   - Reputation-based credit limits
   - Dynamic credit adjustment
   - Risk assessment metrics

2. **Network Effects**
   - Credit network formation
   - Liquidity sharing
   - Path-based transactions

3. **Cross-Chain Integration**
   - Multi-chain reserve management
   - Cross-chain credit networks
   - Unified settlement layer 