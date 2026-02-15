/**
 * Demo accounts for quick testing
 * Each session generates unique random 8-char passwords
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';

function randomPassword(len = 8): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CHARS[b % CHARS.length]).join('');
}

export const DEMO_ACCOUNTS = [
  'alice', 'bob', 'carol', 'dave', 'eve',
  'frank', 'grace', 'heidi', 'ivan', 'judy',
].map(name => ({ name, password: randomPassword(), factor: 1 }));

export const DEFAULT_DEMO_ACCOUNT = DEMO_ACCOUNTS[0];
