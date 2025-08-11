# BigInt Handling in XLN

## Overview
This guide documents solutions for handling BigInt values in JavaScript, addressing common mixing errors and serialization issues encountered in financial systems.

## The BigInt Problem

### Common Error
```
TypeError: Cannot mix BigInt and other types, use explicit conversions
```

This occurs when trying to perform arithmetic operations between BigInt and regular numbers, or when using `JSON.stringify()` on objects containing BigInt values.

## Universal Utility Functions

### Core Conversion Functions
```javascript
/**
 * Safely convert any numeric value to a regular number
 * Handles BigInt, string numbers, and regular numbers
 */
function toNumber(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && !isNaN(value)) {
    return Number(value);
  }
  return typeof value === 'number' ? value : 0;
}

/**
 * Safely convert any numeric value to BigInt
 * Handles numbers, string numbers, and existing BigInts
 */
function toBigInt(value) {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return BigInt(Math.floor(Number(value)));
  }
  return 0n;
}
```

### Safe Arithmetic Operations
```javascript
/**
 * Safe addition that handles BigInt mixing
 */
function safeAdd(a, b) {
  const numA = toNumber(a);
  const numB = toNumber(b);
  return numA + numB;
}

/**
 * Safe multiplication for percentage calculations
 */
function safeMultiply(a, b) {
  const numA = toNumber(a);
  const numB = toNumber(b);
  return numA * numB;
}

/**
 * Safe division with zero protection
 */
function safeDivide(a, b) {
  const numA = toNumber(a);
  const numB = toNumber(b);
  return numB === 0 ? 0 : numA / numB;
}
```

### JSON Serialization
```javascript
/**
 * JSON.stringify that handles BigInt values
 * Converts BigInt to string representation
 */
function safeStringify(obj, space = null) {
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }, space);
}

/**
 * JSON.parse that reconstructs BigInt values
 * Detects numeric strings that should be BigInt
 */
function safeParse(jsonString, bigIntKeys = []) {
  return JSON.parse(jsonString, (key, value) => {
    if (bigIntKeys.includes(key) && typeof value === 'string' && /^\d+$/.test(value)) {
      return BigInt(value);
    }
    return value;
  });
}
```

## Common Usage Patterns

### UI Calculations
```javascript
// Progress bar calculation
function calculateVotingProgress(yesVotingPower, totalVotingPower) {
  // Convert BigInt values to numbers for percentage calculation
  const yesNum = toNumber(yesVotingPower);
  const totalNum = toNumber(totalVotingPower);
  
  const percentage = totalNum > 0 ? (yesNum * 100) / totalNum : 0;
  return Math.round(percentage);
}

// Vote counting
function countVotes(proposal, validators) {
  let yesVotingPower = 0;
  
  for (const [voter, voteData] of proposal.votes) {
    if (voteData.choice === 'yes') {
      const voterPower = toNumber(validators.get(voter) || 0);
      yesVotingPower = safeAdd(yesVotingPower, voterPower);
    }
  }
  
  return yesVotingPower;
}
```

### State Management
```javascript
// Threshold comparison
function checkThresholdReached(votingPower, threshold) {
  const powerNum = toNumber(votingPower);
  const thresholdNum = toNumber(threshold);
  return powerNum >= thresholdNum;
}

// Validator weight updates
function updateValidatorWeight(validators, validatorId, newWeight) {
  const weightBigInt = toBigInt(newWeight);
  return new Map(validators).set(validatorId, weightBigInt);
}
```

### Data Transfer
```javascript
// Preparing data for server
function prepareEntityData(entityData) {
  return {
    ...entityData,
    threshold: toBigInt(entityData.threshold),
    validators: new Map(
      Array.from(entityData.validators).map(([id, weight]) => [
        id, 
        toBigInt(weight)
      ])
    )
  };
}

// Receiving data from server
function processEntityData(rawData) {
  return {
    ...rawData,
    threshold: toBigInt(rawData.threshold),
    validators: new Map(
      Object.entries(rawData.validators).map(([id, weight]) => [
        id,
        toBigInt(weight)
      ])
    )
  };
}
```

## Debug and Logging
```javascript
/**
 * Debug-friendly object inspection
 * Converts BigInt for console.log display
 */
function debugObject(obj, label = '') {
  const debugStr = safeStringify(obj, 2);
  console.log(label ? `${label}:` : '', debugStr);
}

/**
 * Type-safe comparison logging
 */
function debugComparison(a, b, operation = '==') {
  const aNum = toNumber(a);
  const bNum = toNumber(b);
  console.log(`Compare: ${aNum} ${operation} ${bNum} = ${aNum === bNum}`);
  console.log(`Types: ${typeof a} vs ${typeof b}`);
}
```

## Error Prevention Strategies

### 1. Input Validation
```javascript
function validateNumericInput(value, fieldName) {
  if (value === null || value === undefined) {
    throw new Error(`${fieldName} cannot be null or undefined`);
  }
  
  const num = toNumber(value);
  if (isNaN(num)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  
  if (num < 0) {
    throw new Error(`${fieldName} cannot be negative`);
  }
  
  return num;
}
```

### 2. Type Guards
```javascript
function isBigInt(value) {
  return typeof value === 'bigint';
}

function isNumericString(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function canBeNumeric(value) {
  return typeof value === 'number' || 
         typeof value === 'bigint' || 
         isNumericString(value);
}
```

### 3. Safe Map Operations
```javascript
/**
 * Safely get numeric value from Map that might contain BigInt
 */
function getNumericFromMap(map, key, defaultValue = 0) {
  const value = map.get(key);
  return value !== undefined ? toNumber(value) : defaultValue;
}

/**
 * Safely set numeric value in Map as BigInt
 */
function setNumericInMap(map, key, value) {
  map.set(key, toBigInt(value));
  return map;
}
```

## Integration with XLN

### Frontend Integration
```javascript
// In index.html, replace all numeric operations
function renderVotingProgress(proposal, validators) {
  let yesVotingPower = 0;
  let totalVotingPower = 0;
  
  // Safe iteration over validators
  for (const weight of validators.values()) {
    totalVotingPower = safeAdd(totalVotingPower, weight);
  }
  
  // Safe vote counting
  for (const [voter, voteData] of proposal.votes) {
    if (voteData.choice === 'yes') {
      const voterWeight = getNumericFromMap(validators, voter, 0);
      yesVotingPower = safeAdd(yesVotingPower, voterWeight);
    }
  }
  
  // Safe percentage calculation
  const percentage = safeDivide(safeMultiply(yesVotingPower, 100), totalVotingPower);
  return Math.round(percentage);
}
```

### Backend Integration
```javascript
// In entity-tx.ts, safe state updates
function applyEntityTx(state, tx) {
  switch (tx.type) {
    case 'updateThreshold':
      return {
        ...state,
        threshold: toBigInt(tx.data.newThreshold)
      };
      
    case 'addValidator':
      const newValidators = new Map(state.validators);
      setNumericInMap(newValidators, tx.data.validatorId, tx.data.weight);
      return {
        ...state,
        validators: newValidators
      };
  }
  return state;
}
```

## Performance Considerations

### When to Use BigInt vs Number
- **Use BigInt for**: Validator weights, thresholds, financial amounts
- **Use Number for**: UI calculations, percentages, counters, array indices

### Memory Optimization
```javascript
// Convert BigInt to Number for temporary calculations
function optimizedCalculation(bigIntValues) {
  // Convert once at the beginning
  const numbers = bigIntValues.map(toNumber);
  
  // Perform all calculations with numbers
  const result = numbers.reduce((sum, val) => sum + val, 0);
  
  // Convert back to BigInt if needed for storage
  return toBigInt(result);
}
```

## Testing BigInt Handling
```javascript
// Test suite for BigInt utilities
const testCases = [
  { input: 42, expected: 42 },
  { input: 42n, expected: 42 },
  { input: '42', expected: 42 },
  { input: 0n, expected: 0 },
  { input: '0', expected: 0 }
];

function testToNumber() {
  testCases.forEach(({ input, expected }) => {
    const result = toNumber(input);
    console.assert(result === expected, `toNumber(${input}) = ${result}, expected ${expected}`);
  });
}
```

## Migration Checklist

When adding BigInt support to existing code:

1. ✅ Replace `JSON.stringify()` with `safeStringify()`
2. ✅ Replace arithmetic operations with safe functions
3. ✅ Add type conversion at API boundaries
4. ✅ Update comparison operations to use `toNumber()`
5. ✅ Test with mixed BigInt/Number scenarios
6. ✅ Add validation for numeric inputs
7. ✅ Document BigInt fields in interfaces

This approach ensures consistent BigInt handling across the entire XLN system while maintaining compatibility with existing JavaScript numeric operations.
