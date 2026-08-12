import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('custody withdrawal submits visible amount and token instead of re-parsing invoice values', () => {
  const source = readFileSync(resolve(process.cwd(), 'custody/static/app.js'), 'utf8');
  const start = source.indexOf('async function handleWithdrawSubmit(event)');
  const end = source.indexOf('\nload().catch(', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const handler = source.slice(start, end);
  expect(handler).toContain("withdrawAmount = String(formData.get('amount')");
  expect(handler).toContain("selectedTokenId = Number(formData.get('tokenId')");
  expect(handler).not.toContain('withdrawAmount = parsedIntent.amount');
  expect(handler).not.toContain('selectedTokenId = parsedIntent.tokenId');
});
