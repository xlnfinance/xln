import { parseArgs, flagString, flagBool, flagNumber } from '../lib/args';
import { helpText, parseHumanAmount } from '../lib/format';
import { loadSettings, saveSettings, type BarStyle } from '../lib/settings';
import {
  createDemoMnemonic,
  createFromBrainVault,
  resolvePassphrase,
  saveWallet,
  walletExists,
} from '../lib/identity';
import { ask } from '../lib/prompt';
import { closeSession, openSession, logSessionBanner } from '../lib/session';
import { formatAccountsPanel } from '../lib/accounts';
import { listDiscoverableHubs, formatHubList, openHubAccount } from '../lib/actions/open-account';
import { buildReceiveInvoice, sendPayment, type DeliveryMode } from '../lib/actions/pay';
import { placeSwap } from '../lib/actions/swap';
import { executeMove, type MoveKind } from '../lib/actions/move';
import { executeLending, readLendingState, type LendingOp } from '../lib/actions/lending';
import { callDaemon, daemonSocketExists } from '../lib/daemon/client';
import { startDaemonServer } from '../lib/daemon/server';
import { runTui } from '../tui/app';
import { paint } from '../lib/theme';

const requirePassphrase = async (flags: Record<string, string | boolean>): Promise<string> => {
  const fromFlag = flagString(flags, 'passphrase') || flagString(flags, 'p');
  const resolved = resolvePassphrase(fromFlag);
  if (resolved) return resolved;
  return ask('Wallet passphrase: ', true);
};

const withSession = async (
  flags: Record<string, string | boolean>,
  run: (session: Awaited<ReturnType<typeof openSession>>) => Promise<void>,
): Promise<void> => {
  const settings = await loadSettings();
  if (flagString(flags, 'api')) {
    settings.apiBase = flagString(flags, 'api')!.replace(/\/$/, '');
  }
  if (!(await walletExists(settings))) {
    throw new Error('No wallet. Run: xln onboard');
  }
  if (await daemonSocketExists(settings) && !flagBool(flags, 'local')) {
    // Caller should prefer daemon path; this helper is for local in-process.
  }
  const passphrase = await requirePassphrase(flags);
  const session = await openSession(settings, passphrase);
  logSessionBanner(session);
  let runError: unknown;
  try {
    await run(session);
  } catch (error) {
    runError = error;
  } finally {
    try {
      await closeSession(session);
    } catch (closeError) {
      if (runError) throw new AggregateError([runError, closeError], 'CLI_COMMAND_AND_CLOSE_FAILED');
      throw closeError;
    }
  }
  if (runError) throw runError;
};

const runViaDaemonOrLocal = async (
  flags: Record<string, string | boolean>,
  daemonOp: Parameters<typeof callDaemon>[1],
  local: () => Promise<void>,
): Promise<void> => {
  const settings = await loadSettings();
  if (flagString(flags, 'api')) settings.apiBase = flagString(flags, 'api')!.replace(/\/$/, '');
  if (!flagBool(flags, 'local') && (await daemonSocketExists(settings))) {
    const response = await callDaemon(settings, daemonOp);
    if (!response.ok) throw new Error(response.error || 'Daemon request failed');
    if (response.result && typeof response.result === 'object') {
      const text = (response.result as { text?: string; invoice?: string; accounts?: string }).text
        || (response.result as { invoice?: string }).invoice
        || (response.result as { accounts?: string }).accounts;
      if (text) console.log(text);
      else console.log(JSON.stringify(response.result, null, 2));
    } else if (response.result !== undefined) {
      console.log(String(response.result));
    } else {
      console.log(paint('ok', 'ok'));
    }
    return;
  }
  await local();
};

export const runCli = async (argv: string[]): Promise<number> => {
  const { command, positionals, flags } = parseArgs(argv);
  if (flagBool(flags, 'help') || command === 'help' || command === '--help' || command === '-h') {
    console.log(helpText());
    return 0;
  }
  if (flagBool(flags, 'version') || command === 'version' || command === '-v' || command === '--version') {
    console.log('xln-cli 0.1.0');
    return 0;
  }

  if (!command) {
    const settings = await loadSettings();
    if (!(await walletExists(settings))) {
      console.log(paint('warn', 'No wallet found. Starting onboard…'));
      await runOnboard(flags);
    }
    const passphrase = await requirePassphrase(flags);
    const session = await openSession(settings, passphrase);
    try {
      await runTui(session);
    } finally {
      await closeSession(session);
    }
    return 0;
  }

  switch (command) {
    case 'onboard':
      await runOnboard(flags);
      return 0;
    case 'status':
      await runViaDaemonOrLocal(flags, { op: 'status' }, async () => {
        await withSession(flags, async session => {
          console.log(formatAccountsPanel(session.env, session.entityId, session.settings.barStyle));
        });
      });
      return 0;
    case 'hubs':
      await runViaDaemonOrLocal(flags, { op: 'hubs' }, async () => {
        await withSession(flags, async session => {
          const hubs = await listDiscoverableHubs(session);
          console.log(formatHubList(hubs, session));
        });
      });
      return 0;
    case 'open': {
      const hub = positionals[0] || flagString(flags, 'hub');
      if (!hub) throw new Error('Usage: xln open <hubEntityId> [--credit 100] [--token 1]');
      const tokenId = flagNumber(flags, 'token', 1);
      const creditRaw = flagString(flags, 'credit') || '100';
      const creditAmount = parseHumanAmount(creditRaw, tokenId);
      await runViaDaemonOrLocal(
        flags,
        { op: 'open', hubEntityId: hub, creditAmount: creditAmount.toString(), tokenId },
        async () => {
          await withSession(flags, async session => {
            await openHubAccount(session, hub, creditAmount, tokenId);
            console.log(paint('ok', `Opened account with ${hub}`));
          });
        },
      );
      return 0;
    }
    case 'pay': {
      const to = positionals[0] || flagString(flags, 'to');
      const amountRaw = positionals[1] || flagString(flags, 'amount');
      if (!to || !amountRaw) throw new Error('Usage: xln pay <to> <amount> [--token 1] [--mode direct]');
      const tokenId = flagNumber(flags, 'token', 1);
      const amount = parseHumanAmount(amountRaw, tokenId);
      const mode = (flagString(flags, 'mode') || 'direct') as DeliveryMode;
      const hub = flagString(flags, 'hub');
      const description = flagString(flags, 'description') || flagString(flags, 'memo');
      await runViaDaemonOrLocal(
        flags,
        {
          op: 'pay',
          to,
          amount: amount.toString(),
          tokenId,
          mode,
          hub,
          description,
        },
        async () => {
          await withSession(flags, async session => {
            await sendPayment(session, { to, amount, tokenId, mode, hub, description });
            console.log(paint('ok', `Payment queued → ${to} (${amountRaw})`));
          });
        },
      );
      return 0;
    }
    case 'receive':
      await runViaDaemonOrLocal(flags, { op: 'receive' }, async () => {
        await withSession(flags, async session => {
          console.log(buildReceiveInvoice(session));
        });
      });
      return 0;
    case 'swap': {
      const hub = flagString(flags, 'hub') || positionals[0];
      const giveTokenId = flagNumber(flags, 'give', NaN);
      const wantTokenId = flagNumber(flags, 'want', NaN);
      const giveRaw = flagString(flags, 'amount') || positionals[1];
      const wantRaw = flagString(flags, 'want-amount') || positionals[2];
      if (!hub || !Number.isFinite(giveTokenId) || !Number.isFinite(wantTokenId) || !giveRaw || !wantRaw) {
        throw new Error('Usage: xln swap --hub <id> --give <tokenId> --want <tokenId> --amount <give> --want-amount <want>');
      }
      const giveAmount = parseHumanAmount(giveRaw, giveTokenId);
      const wantAmount = parseHumanAmount(wantRaw, wantTokenId);
      await runViaDaemonOrLocal(
        flags,
        {
          op: 'swap',
          hubEntityId: hub,
          giveTokenId,
          wantTokenId,
          giveAmount: giveAmount.toString(),
          wantAmount: wantAmount.toString(),
        },
        async () => {
          await withSession(flags, async session => {
            await placeSwap(session, { hubEntityId: hub, giveTokenId, wantTokenId, giveAmount, wantAmount });
            console.log(paint('ok', 'Swap offer placed'));
          });
        },
      );
      return 0;
    }
    case 'move': {
      const kind = (positionals[0] || '') as MoveKind;
      if (!['r2c', 'r2r', 'r2e'].includes(kind)) {
        throw new Error('Usage: xln move r2c|r2r|r2e --amount <amt> [--token 1] [--counterparty id|--to id]');
      }
      const tokenId = flagNumber(flags, 'token', 1);
      const amountRaw = flagString(flags, 'amount') || positionals[1];
      if (!amountRaw) throw new Error('move requires --amount');
      const amount = parseHumanAmount(amountRaw, tokenId);
      const counterpartyId = flagString(flags, 'counterparty');
      const to = flagString(flags, 'to');
      await runViaDaemonOrLocal(
        flags,
        { op: 'move', kind, amount: amount.toString(), tokenId, counterpartyId, to },
        async () => {
          await withSession(flags, async session => {
            await executeMove(session, { kind, amount, tokenId, counterpartyId, to });
            console.log(paint('ok', `Move ${kind} queued`));
          });
        },
      );
      return 0;
    }
    case 'lend':
    case 'lending': {
      const lendOp = (positionals[0] || '') as LendingOp;
      if (!['offer', 'borrow', 'repay', 'state'].includes(lendOp)) {
        throw new Error('Usage: xln lend offer|borrow|repay|state --hub <id> --amount <amt> [--token 1]');
      }
      const hub = flagString(flags, 'hub') || positionals[1];
      if (!hub) throw new Error('lend requires --hub');
      const tokenId = flagNumber(flags, 'token', 1);
      if (lendOp === 'state') {
        await withSession(flags, async session => {
          console.log(JSON.stringify(await readLendingState(session, hub, tokenId), null, 2));
        });
        return 0;
      }
      const amountRaw = flagString(flags, 'amount') || positionals[2];
      if (!amountRaw) throw new Error('lend requires --amount');
      const amount = parseHumanAmount(amountRaw, tokenId);
      await runViaDaemonOrLocal(
        flags,
        { op: 'lend', lendOp, hubEntityId: hub, amount: amount.toString(), tokenId },
        async () => {
          await withSession(flags, async session => {
            await executeLending(session, { op: lendOp, hubEntityId: hub, amount, tokenId });
            console.log(paint('ok', `Lending ${lendOp} queued`));
          });
        },
      );
      return 0;
    }
    case 'history':
      await withSession(flags, async session => {
        const height = session.env.state.height;
        const entity = [...session.env.state.eReplicas.values()].find(
          r => String(r.state?.entityId || '').toLowerCase() === session.entityId.toLowerCase(),
        );
        console.log(`runtimeHeight=${height}`);
        console.log(`entityHeight=${entity?.state?.height ?? 0}`);
        console.log(formatAccountsPanel(session.env, session.entityId, session.settings.barStyle));
      });
      return 0;
    case 'settings': {
      const settings = await loadSettings();
      const bars = flagString(flags, 'bars') as BarStyle | undefined;
      if (bars === 'closed' || bars === 'twin') settings.barStyle = bars;
      const api = flagString(flags, 'api');
      if (api) settings.apiBase = api.replace(/\/$/, '');
      await saveSettings(settings);
      console.log(JSON.stringify(settings, null, 2));
      return 0;
    }
    case 'daemon': {
      const settings = await loadSettings();
      if (!(await walletExists(settings))) throw new Error('No wallet. Run: xln onboard');
      const passphrase = await requirePassphrase(flags);
      const session = await openSession(settings, passphrase);
      const server = await startDaemonServer(session);
      const shutdown = () => void server.close();
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      try {
        await server.closed;
      } finally {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        await server.close();
        await closeSession(session);
      }
      return 0;
    }
    case 'wallet':
      await withSession(flags, async session => {
        await runTui(session);
      });
      return 0;
    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
};

const runOnboard = async (flags: Record<string, string | boolean>): Promise<void> => {
  const settings = await loadSettings();
  if (await walletExists(settings) && !flagBool(flags, 'force')) {
    throw new Error('Wallet already exists. Pass --force to replace (destructive).');
  }
  console.log(paint('bold', 'xln onboard'));
  console.log('1) demo mnemonic  2) import mnemonic  3) brainvault');
  const mode = flagString(flags, 'mode') || (await ask('Choice [1/2/3]: '));
  let mnemonic = '';
  let label = flagString(flags, 'name') || 'cli-wallet';
  if (mode === '1' || mode === 'demo') {
    mnemonic = createDemoMnemonic();
    console.log(paint('warn', 'Write this mnemonic down — shown once:'));
    console.log(mnemonic);
  } else if (mode === '2' || mode === 'import') {
    mnemonic = flagString(flags, 'mnemonic') || (await ask('Mnemonic: ', true));
  } else if (mode === '3' || mode === 'brainvault' || mode === 'bv') {
    const name = flagString(flags, 'bv-name') || (await ask('BrainVault name: '));
    const bvPass = flagString(flags, 'bv-pass') || (await ask('BrainVault passphrase: ', true));
    const shardInput = flagNumber(flags, 'factor', 1);
    console.log(paint('muted', 'Deriving BrainVault (Argon2)…'));
    mnemonic = await createFromBrainVault({ name, passphrase: bvPass, shardInput });
    label = name;
  } else {
    throw new Error('Invalid onboard mode');
  }
  const passphrase = flagString(flags, 'passphrase') || (await ask('Encrypt wallet with passphrase: ', true));
  const confirm = flagString(flags, 'passphrase') || (await ask('Confirm passphrase: ', true));
  if (passphrase !== confirm) throw new Error('Passphrase mismatch');
  await saveWallet(settings, { mnemonic, passphrase, label });
  console.log(paint('ok', `Wallet saved under ${settings.homeDir}`));
  console.log(paint('muted', 'Bootstrapping runtime (importJ + entity)…'));
  const session = await openSession(settings, passphrase);
  try {
    logSessionBanner(session);
    console.log(paint('ok', 'Ready. Run `xln` for the wallet TUI.'));
  } finally {
    await closeSession(session);
  }
};
