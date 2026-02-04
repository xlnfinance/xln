/**
 * Shared formatting utilities for entity panels
 * Provides consistent formatting across all entity-related components
 */

/**
 * Format a token amount from BigInt to human-readable string
 *
 * @param tokenId - The token identifier (reserved for future token-specific formatting)
 * @param amount - The amount in smallest units (e.g., wei for ETH)
 * @param decimals - Number of decimal places (default: 18)
 * @returns Formatted string representation of the amount
 *
 * @example
 * formatTokenAmount(1, 1000000000000000000n, 18) // "1.0"
 * formatTokenAmount(1, 1234567890123456789n, 18) // "1.234567890123456789"
 */
export function formatTokenAmount(
  tokenId: number,
  amount: bigint,
  decimals: number = 18
): string {
  if (amount === null || amount === undefined) {
    return '0';
  }

  if (decimals < 0 || decimals > 77) {
    throw new Error(`Invalid decimals: ${decimals}. Must be between 0 and 77`);
  }

  try {
    // Convert to string and handle sign
    const isNegative = amount < 0n;
    const absAmount = isNegative ? -amount : amount;
    const amountStr = absAmount.toString().padStart(decimals + 1, '0');

    // Split into integer and fractional parts
    const integerPart = amountStr.slice(0, -decimals) || '0';
    const fractionalPart = amountStr.slice(-decimals);

    // Remove trailing zeros from fractional part
    const trimmedFractional = fractionalPart.replace(/0+$/, '');

    // Construct result
    const sign = isNegative ? '-' : '';
    if (trimmedFractional.length === 0) {
      return `${sign}${integerPart}`;
    }

    return `${sign}${integerPart}.${trimmedFractional}`;
  } catch (error) {
    console.error('Error formatting token amount:', error);
    return '0';
  }
}

/**
 * Format an entity ID for display (full ID, no truncation)
 *
 * @param entityId - The full entity identifier
 * @returns Full entity ID string
 */
export function formatEntityId(entityId: string): string {
  if (!entityId || typeof entityId !== 'string') {
    return '';
  }
  return entityId;
}

/**
 * Format a timestamp in milliseconds to human-readable format
 *
 * @param ms - Timestamp in milliseconds since Unix epoch
 * @returns Formatted date and time string
 *
 * @example
 * formatTimestamp(1609459200000) // "1/1/2021, 12:00:00 AM" (locale-dependent)
 * formatTimestamp(Date.now()) // Current date and time
 */
export function formatTimestamp(ms: number): string {
  if (ms === null || ms === undefined || typeof ms !== 'number' || Number.isNaN(ms)) {
    return 'Invalid Date';
  }

  if (ms < 0) {
    return 'Invalid Date';
  }

  try {
    const date = new Date(ms);

    // Check if date is valid
    if (Number.isNaN(date.getTime())) {
      return 'Invalid Date';
    }

    // Format using locale-aware formatting
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (error) {
    console.error('Error formatting timestamp:', error);
    return 'Invalid Date';
  }
}

/**
 * Format a numeric value as currency
 *
 * @param value - The numeric value to format
 * @param currency - Currency code (default: 'USD')
 * @returns Formatted currency string
 *
 * @example
 * formatCurrency(1234.56) // "$1,234.56"
 * formatCurrency(1234.56, 'EUR') // "€1,234.56" (locale-dependent)
 */
export function formatCurrency(value: number, currency: string = 'USD'): string {
  if (value === null || value === undefined || typeof value !== 'number' || Number.isNaN(value)) {
    return '$0.00';
  }

  if (!Number.isFinite(value)) {
    return 'Invalid Amount';
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch (error) {
    console.error('Error formatting currency:', error);
    // Fallback to USD if currency code is invalid
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      return `${value.toFixed(2)}`;
    }
  }
}

/**
 * Parse a user input string to BigInt amount
 *
 * @param str - String representation of the amount (e.g., "1.5", "0.001")
 * @param decimals - Number of decimal places to use (default: 18)
 * @returns BigInt representation in smallest units
 * @throws Error if the input string is invalid
 *
 * @example
 * parseAmount("1.0", 18) // 1000000000000000000n
 * parseAmount("0.5", 18) // 500000000000000000n
 * parseAmount("123", 6) // 123000000n
 */
export function parseAmount(str: string, decimals: number = 18): bigint {
  if (!str || typeof str !== 'string') {
    throw new Error('Invalid input: must be a non-empty string');
  }

  if (decimals < 0 || decimals > 77) {
    throw new Error(`Invalid decimals: ${decimals}. Must be between 0 and 77`);
  }

  // Remove whitespace
  const trimmed = str.trim();

  if (trimmed.length === 0) {
    throw new Error('Invalid input: empty string');
  }

  // Check for valid number format
  const numberRegex = /^-?\d+(\.\d+)?$/;
  if (!numberRegex.test(trimmed)) {
    throw new Error(`Invalid number format: ${trimmed}`);
  }

  try {
    // Handle sign
    const isNegative = trimmed.startsWith('-');
    const absStr = isNegative ? trimmed.slice(1) : trimmed;

    // Split into integer and fractional parts
    const parts = absStr.split('.');
    const integerPart = parts[0] || '0';
    const fractionalPart = (parts[1] || '').padEnd(decimals, '0');

    // Check if fractional part exceeds decimals
    if (fractionalPart.length > decimals) {
      throw new Error(
        `Too many decimal places: ${parts[1]?.length || 0} (max: ${decimals})`
      );
    }

    // Combine parts
    const combined = integerPart + fractionalPart.slice(0, decimals);

    // Remove leading zeros but keep at least one digit
    const normalized = combined.replace(/^0+/, '') || '0';

    // Convert to BigInt
    const result = BigInt(normalized);

    return isNegative ? -result : result;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to parse amount: ${str}`);
  }
}
