import * as readline from 'node:readline';
import type { CliSession } from '../lib/session';
import { formatAccountsPanel } from '../lib/accounts';
import { headerLine, shortId } from '../lib/presentation/format';
import { paint } from '../lib/presentation/theme';
import { saveSettings, type BarStyle } from '../lib/settings';
import { listDiscoverableHubs, formatHubList, openHubAccount } from '../lib/actions/open-account';
import { buildReceiveInvoice, sendPayment, type DeliveryMode } from '../lib/actions/pay';
import { placeSwap } from '../lib/actions/swap';
import { executeMove } from '../lib/actions/move';
import { executeLending, readLendingState } from '../lib/actions/lending';
import { parseHumanAmount } from '../lib/presentation/format';

type Tab =
  | 'accounts'
  | 'open'
  | 'pay'
  | 'receive'
  | 'swap'
  | 'move'
  | 'lending'
  | 'history'
  | 'manage';

const TABS: Tab[] = ['accounts', 'open', 'pay', 'receive', 'swap', 'move', 'lending', 'history', 'manage'];

const clear = (): void => {
  process.stdout.write('\x1b[2J\x1b[H');
};

const renderChrome = (session: CliSession, tab: Tab, status: string): void => {
  clear();
  console.log(paint('bold', 'xln wallet'));
  console.log(
    paint(
      'muted',
      `${shortId(session.entityId, 10, 6)} · ${session.jurisdictionName} · ${session.settings.apiBase} · bars=${session.settings.barStyle}`,
    ),
  );
  console.log(
    TABS.map(t => (t === tab ? paint('inverse', ` ${t} `) : paint('muted', ` ${t} `))).join(''),
  );
  console.log(headerLine(tab));
  if (status) console.log(paint('warn', status));
  console.log('');
};

const question = (rl: readline.Interface, prompt: string): Promise<string> =>
  new Promise(resolve => {
    rl.question(prompt, answer => resolve(String(answer || '').trim()));
  });

export const runTui = async (session: CliSession): Promise<void> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let tab: Tab = 'accounts';
  let status = '';

  const refreshAccounts = (): void => {
    console.log(formatAccountsPanel(session.env, session.entityId, session.settings.barStyle));
    console.log('');
    console.log(paint('muted', 'keys: 1-9 tabs · r refresh · q quit'));
  };

  try {
    while (true) {
      renderChrome(session, tab, status);
      status = '';

      if (tab === 'accounts') {
        refreshAccounts();
        const key = await question(rl, '> ');
        if (key === 'q' || key === 'quit' || key === 'exit') break;
        if (key === 'r' || key === '') continue;
        const asNum = Number(key);
        if (Number.isInteger(asNum) && asNum >= 1 && asNum <= TABS.length) {
          tab = TABS[asNum - 1]!;
          continue;
        }
        if (TABS.includes(key as Tab)) {
          tab = key as Tab;
          continue;
        }
        status = `Unknown input: ${key}`;
        continue;
      }

      if (tab === 'open') {
        const hubs = await listDiscoverableHubs(session);
        console.log(formatHubList(hubs, session));
        console.log('');
        console.log(paint('muted', 'Enter hub # or entityId. Empty to go back. `id <entity>` for direct open.'));
        const answer = await question(rl, 'open> ');
        if (!answer) {
          tab = 'accounts';
          continue;
        }
        try {
          let hubId = answer;
          if (/^\d+$/.test(answer)) {
            const hub = hubs[Number(answer) - 1];
            if (!hub) throw new Error('Hub index out of range');
            hubId = hub.entityId;
          }
          if (answer.startsWith('id ')) hubId = answer.slice(3).trim();
          const creditRaw = (await question(rl, 'credit amount [100]: ')) || '100';
          const tokenRaw = (await question(rl, 'token id [1]: ')) || '1';
          const tokenId = Number(tokenRaw);
          const creditAmount = parseHumanAmount(creditRaw, tokenId);
          await openHubAccount(session, hubId, creditAmount, tokenId);
          status = `Opened ${hubId}`;
          tab = 'accounts';
        } catch (err) {
          status = err instanceof Error ? err.message : String(err);
        }
        continue;
      }

      if (tab === 'pay') {
        console.log(formatAccountsPanel(session.env, session.entityId, session.settings.barStyle));
        const to = await question(rl, 'to entityId: ');
        if (!to) {
          tab = 'accounts';
          continue;
        }
        const amountRaw = await question(rl, 'amount: ');
        const tokenId = Number((await question(rl, 'token id [1]: ')) || '1');
        const mode = ((await question(rl, 'mode direct|trusted|instant|async [direct]: ')) ||
          'direct') as DeliveryMode;
        const hub = await question(rl, 'hub (optional gateway): ');
        try {
          const amount = parseHumanAmount(amountRaw, tokenId);
          await sendPayment(session, {
            to,
            amount,
            tokenId,
            mode,
            hub: hub || undefined,
          });
          status = `Payment queued → ${to}`;
          tab = 'accounts';
        } catch (err) {
          status = err instanceof Error ? err.message : String(err);
        }
        continue;
      }

      if (tab === 'receive') {
        console.log(buildReceiveInvoice(session));
        await question(rl, '[enter] back ');
        tab = 'accounts';
        continue;
      }

      if (tab === 'swap') {
        console.log(formatAccountsPanel(session.env, session.entityId, session.settings.barStyle));
        const hub = await question(rl, 'hub entityId: ');
        if (!hub) {
          tab = 'accounts';
          continue;
        }
        const giveTokenId = Number(await question(rl, 'give tokenId: '));
        const wantTokenId = Number(await question(rl, 'want tokenId: '));
        const giveRaw = await question(rl, 'give amount: ');
        const wantRaw = await question(rl, 'want amount: ');
        try {
          await placeSwap(session, {
            hubEntityId: hub,
            giveTokenId,
            wantTokenId,
            giveAmount: parseHumanAmount(giveRaw, giveTokenId),
            wantAmount: parseHumanAmount(wantRaw, wantTokenId),
          });
          status = 'Swap offer queued';
          tab = 'accounts';
        } catch (err) {
          status = err instanceof Error ? err.message : String(err);
        }
        continue;
      }

      if (tab === 'move') {
        const kind = await question(rl, 'kind r2c|r2r|r2e: ');
        if (!kind) {
          tab = 'accounts';
          continue;
        }
        const amountRaw = await question(rl, 'amount: ');
        const tokenId = Number((await question(rl, 'token id [1]: ')) || '1');
        const counterpartyId = kind === 'r2c' ? await question(rl, 'counterparty: ') : undefined;
        const to = kind !== 'r2c' ? await question(rl, 'to: ') : undefined;
        try {
          await executeMove(session, {
            kind: kind as 'r2c' | 'r2r' | 'r2e',
            amount: parseHumanAmount(amountRaw, tokenId),
            tokenId,
            counterpartyId,
            to,
          });
          status = `Move ${kind} queued`;
          tab = 'accounts';
        } catch (err) {
          status = err instanceof Error ? err.message : String(err);
        }
        continue;
      }

      if (tab === 'lending') {
        const op = await question(rl, 'op offer|borrow|repay|state: ');
        if (!op) {
          tab = 'accounts';
          continue;
        }
        const hub = await question(rl, 'hub entityId: ');
        const tokenId = Number((await question(rl, 'token id [1]: ')) || '1');
        try {
          if (op === 'state') {
            console.log(JSON.stringify(await readLendingState(session, hub, tokenId), null, 2));
            await question(rl, '[enter] ');
          } else {
            const amountRaw = await question(rl, 'amount: ');
            await executeLending(session, {
              op: op as 'offer' | 'borrow' | 'repay',
              hubEntityId: hub,
              amount: parseHumanAmount(amountRaw, tokenId),
              tokenId,
            });
            status = `Lending ${op} queued`;
            tab = 'accounts';
          }
        } catch (err) {
          status = err instanceof Error ? err.message : String(err);
        }
        continue;
      }

      if (tab === 'history') {
        console.log(`runtimeHeight=${session.env.state.height}`);
        console.log(formatAccountsPanel(session.env, session.entityId, session.settings.barStyle));
        await question(rl, '[enter] back ');
        tab = 'accounts';
        continue;
      }

      if (tab === 'manage') {
        console.log(`barStyle: ${session.settings.barStyle} (closed|twin)`);
        console.log(`apiBase:  ${session.settings.apiBase}`);
        console.log(`dbPath:   ${session.settings.dbPath}`);
        console.log(`socket:   ${session.settings.socketPath}`);
        const next = await question(rl, 'set bars|api|back: ');
        if (!next || next === 'back') {
          tab = 'accounts';
          continue;
        }
        if (next.startsWith('bars')) {
          const style = (next.split(/\s+/)[1] || (await question(rl, 'closed|twin: '))) as BarStyle;
          if (style !== 'closed' && style !== 'twin') {
            status = 'bars must be closed|twin';
            continue;
          }
          session.settings.barStyle = style;
          await saveSettings(session.settings);
          status = `bars=${style}`;
          continue;
        }
        if (next.startsWith('api')) {
          const url = next.split(/\s+/)[1] || (await question(rl, 'api base url: '));
          session.settings.apiBase = url.replace(/\/$/, '');
          await saveSettings(session.settings);
          status = `api=${session.settings.apiBase}`;
          continue;
        }
        status = `Unknown manage command: ${next}`;
      }
    }
  } finally {
    rl.close();
  }
};
