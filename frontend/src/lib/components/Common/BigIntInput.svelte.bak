<script lang="ts">
  /**
   * BigInt-native input component for financial amounts
   * Handles decimal display while maintaining BigInt precision internally
   */

  export let value: bigint = 0n;
  export let decimals: number = 18;
  export let placeholder: string = '0.0';
  export let disabled: boolean = false;

  // Internal string representation for display
  let displayValue: string = '';

  // Convert BigInt to decimal string for display
  function bigintToDecimal(amount: bigint, decimals: number): string {
    if (amount === 0n) return '0';

    const divisor = BigInt(10 ** decimals);
    const wholePart = amount / divisor;
    const fractionalPart = amount % divisor;

    if (fractionalPart === 0n) {
      return wholePart.toString();
    }

    const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
    const trimmed = fractionalStr.replace(/0+$/, ''); // Remove trailing zeros
    return `${wholePart}.${trimmed}`;
  }

  // Convert decimal string to BigInt
  function decimalToBigint(str: string, decimals: number): bigint {
    if (!str || str === '') return 0n;

    const parts = str.split('.');
    const wholePart = BigInt(parts[0] || '0');
    const fractionalPart = parts[1] || '';
    const paddedFractional = fractionalPart.padEnd(decimals, '0').slice(0, decimals);

    return wholePart * BigInt(10 ** decimals) + BigInt(paddedFractional || '0');
  }

  // Initialize display value
  $: displayValue = bigintToDecimal(value, decimals);

  // Handle input changes
  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    const newValue = target.value;

    // Validate input (only numbers and one decimal point)
    if (!/^\d*\.?\d*$/.test(newValue)) {
      target.value = displayValue;
      return;
    }

    displayValue = newValue;

    try {
      value = decimalToBigint(newValue, decimals);
    } catch (error) {
      console.warn('Invalid BigInt input:', error);
    }
  }
</script>

<input
  type="text"
  bind:value={displayValue}
  on:input={handleInput}
  {placeholder}
  {disabled}
  class="bigint-input"
/>

<style>
  .bigint-input {
    font-family: 'Courier New', monospace;
    text-align: right;
    padding: 8px 12px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1e1e1e;
    color: #d4d4d4;
  }

  .bigint-input:focus {
    outline: none;
    border-color: #007acc;
  }

  .bigint-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>