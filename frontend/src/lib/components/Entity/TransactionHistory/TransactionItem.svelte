<script lang="ts">
  import type { BankingTransaction } from '$lib/types/ui';

  export let transaction: BankingTransaction;
</script>

<div class="banking-transaction-item banking-{transaction.type}">
  <div class="transaction-icon">{transaction.icon}</div>
  <div class="transaction-details">
    <div class="transaction-primary">{transaction.primaryInfo}</div>
    <div class="transaction-secondary">{transaction.secondaryInfo}</div>
  </div>
  <div class="transaction-amount">{transaction.amount}</div>
</div>

<style>
  .banking-transaction-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: #1e1e1e;
    border-radius: 4px;
    border-left: 2px solid #404040;
  }

  .banking-transaction-item.banking-input {
    border-left-color: #3b82f6;
  }

  .banking-transaction-item.banking-output {
    border-left-color: #f59e0b;
  }

  .banking-transaction-item.banking-import {
    border-left-color: #8b5cf6;
  }

  .transaction-icon {
    font-size: 1em;
    width: 20px;
    text-align: center;
  }

  .transaction-details {
    flex: 1;
    min-width: 0;
  }

  .transaction-primary {
    font-size: 0.8em;
    font-weight: 500;
    color: #d4d4d4;
    margin-bottom: 2px;
  }

  .transaction-secondary {
    font-size: 0.7em;
    color: #9d9d9d;
    line-height: 1.2;
    word-wrap: break-word;
  }

  .transaction-amount {
    font-size: 0.7em;
    color: #fbbf24;
    font-weight: bold;
    text-align: right;
    min-width: fit-content;
  }
</style>
