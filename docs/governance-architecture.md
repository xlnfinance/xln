# 🏛️ XLN Integrated Governance Architecture

Торгуемые токены контроля и дивидендов встроенные в EntityProvider

## 📋 1. Архитектурные улучшения

### Интеграция в EntityProvider
- ✅ Один контракт вместо двух
- ✅ EntityProvider наследует ERC1155
- ✅ Автоматические токены для каждой entity
- ✅ Первый бит определяет control vs dividend

### Foundation Entity #1
- ✅ Создается автоматически при деплое
- ✅ Имеет свои control/dividend токены
- ✅ Может заменять кворумы с максимальным delay
- ✅ nextNumber начинается с 2

### Token ID схема
- ✅ `controlTokenId = entityNumber` (оригинальный ID)
- ✅ `dividendTokenId = entityNumber | 0x800...000` (первый бит)
- ✅ `getEntityFromToken()` извлекает entityNumber
- ✅ Работает для всех entity IDs включая lazy

### Articles of Incorporation
- ✅ Хранятся как `keccak256(abi.encode(articles))`
- ✅ Приносятся в calldata для верификации
- ✅ Экономия gas при обновлениях
- ✅ Иммутабельные после создания

## 📋 2. Priority System для замены кворума

**Priority**: `CONTROL > QUORUM > DIVIDEND > FOUNDATION`

| Proposer   | Can Cancel                              |
|------------|-----------------------------------------|
| CONTROL    | QUORUM, DIVIDEND, FOUNDATION proposals  |
| QUORUM     | DIVIDEND, FOUNDATION proposals          |  
| DIVIDEND   | FOUNDATION proposals only               |
| FOUNDATION | Cannot cancel anyone                    |

**Delays (configurable in articles):**
- Control: X blocks
- Dividend: X*3 blocks  
- Foundation: X*10 blocks (0 = disabled)

## 📋 3. Meta-Style Entity Creation

**Example Entity #42:**
```
Entity Number: 42
Control Token ID: 42
Dividend Token ID: 0x8000000000000000000000000000000000000000000000000000000000000042
```

**Token Distribution:**
- `founder`: 51.0% control, 10.0% dividend
- `public_investors`: 20.0% control, 60.0% dividend  
- `employees`: 15.0% control, 20.0% dividend
- `vcs`: 14.0% control, 10.0% dividend

**Governance Config:**
- Control Delay: 1000 blocks
- Dividend Delay: 3000 blocks
- Foundation Delay: 10000 blocks
- Control Threshold: 51%

## 📋 4. Complete Workflow Example

### Step 1: Entity Registration
```solidity
registerNumberedEntity(boardHash) → entityNumber = 42
```

### Step 2: Governance Setup  
```solidity
setupGovernance(
  entityNumber: 42,
  holders: ['founder', 'public_investors', 'employees', 'vcs'],
  controlAmounts: [510, 200, 150, 140],
  dividendAmounts: [100, 600, 200, 100],
  articles: {controlDelay: 1000, dividendDelay: 3000, ...}
)
```

**Result:**
- Создаются токены 42 (control) и 0x800...042 (dividend)
- Минтятся в соответствии с initialDistribution
- articlesHash сохраняется в entities[42]

### Step 3: Trading (ERC1155 standard)
```solidity
safeTransferFrom(founder, activist_investor, 42, 100, "")
```
- Activist получает 100 control tokens (10%)
- totalControlSupply автоматически tracked

### Step 4: Quorum Replacement Proposal
```solidity
proposeQuorumReplacement(
  entityNumber: 42,
  newQuorum: new_quorum_hash,
  proposerType: CONTROL,
  articles: {...}
)
```

**Result:**
- Proposal сохраняется с delay = 1000 blocks
- Event: QuorumReplacementProposed

### Step 5: Execution After Delay
```solidity
executeQuorumReplacement(
  entityNumber: 42,
  supporters: ['founder', 'activist_investor'],
  articles: {...}
)
```

**Result:**
- Проверка: delay прошёл + 51% control support
- `entities[42].currentBoardHash = newQuorum`
- Event: QuorumReplaced

## 📋 5. Emergency Scenarios

### 🚨 Scenario A: Control shareholder hostile takeover prevention
1. Hostile entity покупает 40% control tokens
2. Предлагает замену кворума (delay = 1000 blocks)
3. За 1000 blocks incumbent holders могут:
   - Купить токены обратно
   - Организовать защитную коалицию
   - Предложить альтернативный кворум

### 🚨 Scenario B: Dividend shareholders coordination
1. Dividend holders недовольны управлением
2. Организуют 51%+ коалицию
3. Предлагают новый кворум (delay = 3000 blocks)
4. Control holders могут отменить и предложить свой

### 🚨 Scenario C: Foundation emergency intervention
1. Все shareholders исчезли/недоступны
2. Entity парализована > месяца
3. Foundation предлагает новый кворум (delay = 10000 blocks)
4. Никто не может отменить → выполняется

## 📋 6. Key Features vs Traditional DAO

### Traditional DAO
- ❌ Один токен = control + economics
- ❌ Нельзя продать economics отдельно
- ❌ Whale governance неизбежен
- ❌ Дорогие ERC20 transfers
- ❌ Нет emergency coordination

### XLN Integrated Governance
- ✅ Разделение control/dividend как Meta/Alphabet
- ✅ ERC1155 gas efficiency
- ✅ Multi-layer emergency system
- ✅ Priority-based proposal cancellation
- ✅ Immutable articles of incorporation
- ✅ Foundation fallback protection
- ✅ Automatic token supply tracking

## 📋 7. Key Smart Contract Functions

### Entity & Governance Creation
```solidity
registerNumberedEntity(boardHash) → entityNumber
setupGovernance(entityNumber, holders[], controlAmounts[], dividendAmounts[], articles)
```

### Token Operations (ERC1155)
```solidity
balanceOf(holder, tokenId) → amount
safeTransferFrom(from, to, tokenId, amount, data)
getTokenIds(entityNumber) → (controlTokenId, dividendTokenId)
```

### Quorum Replacement
```solidity
proposeQuorumReplacement(entityNumber, newQuorum, proposerType, articles)
executeQuorumReplacement(entityNumber, supporters[], articles)
```

### View Functions  
```solidity
getGovernanceInfo(entityNumber) → (controlTokenId, dividendTokenId, supplies, hasProposal, articlesHash)
getEntityFromToken(tokenId) → entityNumber
```

## 📋 8. Deployment Checklist

- ✅ EntityProvider наследует ERC1155
- ✅ Foundation entity #1 создается автоматически
- ✅ nextNumber начинается с 2
- ✅ Token ID схема с первым битом
- ✅ Priority system для cancellation
- ✅ Articles hash verification
- ✅ Multi-delay system
- ✅ Automatic supply tracking
- ✅ Event emissions для indexing
- ✅ Gas optimizations

## 🎯 Итог

✨ **Полностью интегрированная governance система в EntityProvider**

🏢 **Meta/Alphabet style разделение control/dividend прав**

🛡️ **Multi-layer emergency protection system**

⚡ **ERC1155 gas efficiency + automatic supply tracking**

🎭 **Priority-based proposal management**

📜 **Immutable articles of incorporation**

💰 **Готово для trading в XLN hubs**

---

**Updated file:** `contracts/contracts/EntityProvider.sol`

**🚀 Ready for Meta/Alphabet style governance!** 