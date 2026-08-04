import { formatTokenAmountEthers, getTokenInfo } from '../../runtime/runtime.ts';
import { paint } from './theme';

export const shortId = (id: string, head = 6, tail = 4): string => {
  const value = String(id || '');
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
};

export const formatAmount = (amount: bigint, tokenId: number): string => {
  try {
    const info = getTokenInfo(tokenId);
    return `${formatTokenAmountEthers(amount, info.decimals)} ${info.symbol}`;
  } catch {
    return `${amount.toString()} #${tokenId}`;
  }
};

export const parseHumanAmount = (raw: string, tokenId: number): bigint => {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Amount is required');
  if (/^\d+n?$/.test(text)) return BigInt(text.replace(/n$/, ''));
  const info = getTokenInfo(tokenId);
  const [whole, frac = ''] = text.split('.');
  if (!/^\d+$/.test(whole || '') || (frac && !/^\d+$/.test(frac))) {
    throw new Error(`Invalid amount: ${text}`);
  }
  const decimals = info.decimals;
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
};

export const headerLine = (title: string, width = 72): string => {
  const label = ` ${title} `;
  const pad = Math.max(0, width - label.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return paint('accent', `${'─'.repeat(left)}${label}${'─'.repeat(right)}`);
};

export const helpText = (): string =>
  [
    'xln — terminal wallet (in-process runtime)',
    '',
    'Usage:',
    '  xln                     interactive wallet TUI',
    '  xln status              show entity + accounts',
    '  xln hubs                list discovered hubs',
    '  xln open <hubEntityId> [--credit <amt>] [--token <id>]',
    '  xln pay <to> <amount> [--token <id>] [--mode direct|trusted|instant|async]',
    '  xln receive             print receive invoice / entity id',
    '  xln swap --give <id> --want <id> --amount <amt> --hub <id> [--price <ticks>]',
    '  xln move r2c|r2r|r2e …  reserve moves',
    '  xln lend offer|borrow|repay …',
    '  xln history             recent entity activity',
    '  xln settings [--bars closed|twin] [--api <url>]',
    '  xln daemon              shared local socket daemon for agents',
    '  xln onboard             create/import wallet',
    '  xln help',
    '',
    'Env:',
    '  XLN_API_BASE   API origin (default https://xln.finance)',
    '  XLN_HOME       config/db root (default ~/.xln)',
    '  XLN_DB_PATH    LevelDB root override',
    '  XLN_CLI_SOCKET unix socket for daemon',
    '  XLN_PASSPHRASE wallet unlock (non-interactive)',
  ].join('\n');
