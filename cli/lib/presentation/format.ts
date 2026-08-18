import { formatTokenAmount, parseTokenAmount } from '../../../core/runtime.ts';
import { paint } from './theme';

export const shortId = (id: string, head = 6, tail = 4): string => {
  const value = String(id || '');
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
};

export const formatAmount = (amount: bigint, tokenId: number): string => {
  try {
    // Canonical "<amount> <symbol>" from the runtime's own token registry, so
    // CLI output cannot drift from what every other surface prints.
    return formatTokenAmount(tokenId, amount);
  } catch {
    return `${amount.toString()} #${tokenId}`;
  }
};

export const parseHumanAmount = (raw: string, tokenId: number): bigint => {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Amount is required');
  if (/^\d+n$/.test(text)) return BigInt(text.slice(0, -1));
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`Invalid amount: ${text}`);
  return parseTokenAmount(tokenId, text);
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
