#!/usr/bin/env bun

import { createInterface } from 'node:readline';
import { runPaymentWork } from './model';
import type { PaymentWorkRequest } from './types';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

console.log(JSON.stringify({ type: 'ready' }));
for await (const line of lines) {
  const request = JSON.parse(line) as PaymentWorkRequest;
  const result = runPaymentWork(request);
  console.log(JSON.stringify({
    ...result,
    output: Buffer.from(result.output).toString('base64'),
  }));
}
