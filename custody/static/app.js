/**
 * @typedef {{
 *   userId: string,
 *   createdAt: number,
 *   lastSeenAt: number,
 * }} SessionInfo
 *
 * @typedef {{
 *   entityId: string,
 *   name: string,
 *   signerId: string | null,
 *   daemonWsUrl: string,
 *   walletUrl: string,
 *   jurisdictionId: string | null,
 *   connected: boolean,
 *   lastSyncOkAt: number | null,
 *   lastSyncError: string | null,
 * }} CustodyInfo
 * @typedef {{
 *   tokenId: number,
 *   symbol: string,
  *   name: string,
  *   decimals: number,
  *   accent: string,
  *   amountMinor: string,
  *   amountDisplay: string,
 * }} TokenRow
 *
 * @typedef {{
 *   tokenId: number,
 *   symbol: string,
 *   amountMinor: string,
 *   amountDisplay: string,
 * }} HeadlineBalance
 *
 * @typedef {{
 *   kind: 'deposit' | 'withdrawal',
 *   id: string,
 *   status: string,
 *   tokenId: number,
 *   amountMinor: string,
 *   amountDisplay: string,
 *   requestedAmountMinor?: string,
 *   requestedAmountDisplay?: string,
 *   feeMinor?: string,
 *   feeDisplay?: string,
 *   description: string,
 *   counterpartyEntityId: string,
 *   hashlock: string | null,
 *   frameHeight: number | null,
 *   createdAt: number,
 *   updatedAt: number,
 *   error?: string | null,
 * }} ActivityItem
 *
 * @typedef {{
 *   session: SessionInfo,
 *   custody: CustodyInfo,
 *   headlineBalance: HeadlineBalance,
 *   tokens: TokenRow[],
 *   activity: ActivityItem[],
 * }} DashboardPayload
 */

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app container');
}

/** @type {DashboardPayload | null} */
let state = null;
let withdrawMessage = '';
let withdrawError = '';
let submitting = false;
let selectedTokenId = 1;
let withdrawAmount = '';
let withdrawTargetEntityId = '';
let depositTokenId = 1;
let depositAmount = '10';
let depositHint = '';
let pendingInvoice = '';
let pendingWalletHref = '';
let pendingQrSrc = '';
let pendingDepositIntentKey = '';
let pendingDepositInvoiceId = '';
let lastDashboardFingerprint = '';
let copyInvoiceResetTimer = null;
const WALLET_WINDOW_NAME = 'xln-wallet';

const updateDepositHintUi = () => {
  const nodes = app.querySelectorAll('[data-deposit-hint]');
  nodes.forEach((node) => {
    node.textContent = depositHint || '';
    node.classList.toggle('hidden', !depositHint);
  });
};

const captureActiveField = () => {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement)) {
    return null;
  }
  if (!app.contains(active)) return null;
  const fieldName = active.name;
  if (!fieldName) return null;
  return {
    name: fieldName,
    tag: active.tagName,
    selectionStart: active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null,
    selectionEnd: active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionEnd : null,
  };
};

const restoreActiveField = (snapshot) => {
  if (!snapshot) return;
  const selector = `[name="${CSS.escape(snapshot.name)}"]`;
  const next = app.querySelector(selector);
  if (!(next instanceof HTMLInputElement || next instanceof HTMLSelectElement || next instanceof HTMLTextAreaElement)) {
    return;
  }
  next.focus({ preventScroll: true });
  if (
    snapshot.selectionStart !== null &&
    snapshot.selectionEnd !== null &&
    (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)
  ) {
    try {
      next.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    } catch {
      // ignore non-text inputs
    }
  }
};

const escapeHtml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const shortId = (value) => {
  const raw = String(value || '');
  if (raw.length <= 16) return raw;
  return `${raw.slice(0, 10)}...${raw.slice(-8)}`;
};

const formatTime = (value) => {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
};

const getSelectedDepositToken = () => {
  if (!state) return null;
  return state.tokens.find((token) => token.tokenId === depositTokenId) || state.tokens[0] || null;
};

const createInvoiceId = () => {
  return `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
};

const appendPaymentTimestamp = (description, startedAtMs = Date.now()) => {
  const clean = String(description || '')
    .replace(/\btsms:\d{10,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const marker = `tsms:${Math.max(0, Math.trunc(startedAtMs))}`;
  return clean ? `${clean} ${marker}` : marker;
};

const buildWalletPayHref = (sourceState, tokenId, amount, invoiceId) => {
  if (!sourceState?.custody?.walletUrl) return '';
  const startedAtMs = Date.now();
  const base = new URL(sourceState.custody.walletUrl);
  const url = new URL('/app', base.origin);
  const params = new URLSearchParams();
  params.set('id', sourceState.custody.entityId);
  params.set('token', String(tokenId));
  params.set('amt', String(amount).trim());
  params.set('u', sourceState.session.userId);
  params.set('desc', appendPaymentTimestamp(`Custody invoice:${invoiceId}`, startedAtMs));
  params.set('locked', '1');
  params.set('mode', 'htlc');
  params.set('ts', String(startedAtMs));
  if (sourceState.custody.jurisdictionId) {
    params.set('jId', sourceState.custody.jurisdictionId);
  }
  url.hash = `pay?${params.toString()}`;
  return url.toString();
};

const buildInvoiceUri = (sourceState, tokenId, amount, invoiceId) => {
  const startedAtMs = Date.now();
  const params = new URLSearchParams();
  params.set('id', sourceState.custody.entityId);
  params.set('token', String(tokenId));
  params.set('amt', String(amount).trim());
  params.set('u', sourceState.session.userId);
  params.set('desc', appendPaymentTimestamp(`Custody invoice:${invoiceId}`, startedAtMs));
  params.set('locked', '1');
  params.set('mode', 'htlc');
  params.set('ts', String(startedAtMs));
  if (sourceState.custody.jurisdictionId) {
    params.set('jId', sourceState.custody.jurisdictionId);
  }
  return `xln:?${params.toString()}`;
};

const parsePaymentIntent = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const parseParams = (params) => {
    const entityId = String(params.get('id') || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/i.test(entityId)) return null;
    const tokenIdValue = Number(params.get('token') || '1');
    const amount = String(params.get('amt') || '').trim();
    return {
      entityId,
      tokenId: Number.isFinite(tokenIdValue) && tokenIdValue > 0 ? tokenIdValue : 1,
      amount,
    };
  };

  try {
    if (raw.startsWith('xln:?')) {
      return parseParams(new URLSearchParams(raw.slice('xln:?'.length)));
    }
    const url = new URL(raw);
    if (url.hash.startsWith('#pay?')) {
      return parseParams(new URLSearchParams(url.hash.slice('#pay?'.length)));
    }
  } catch {
    // fall through to raw entity id
  }

  if (/^0x[0-9a-f]{64}$/i.test(raw)) {
    return {
      entityId: raw.toLowerCase(),
      tokenId: selectedTokenId,
      amount: '',
    };
  }

  return null;
};

const syncDepositTargets = (tokenId, amount, sourceState = state, options = {}) => {
  const forceInvoiceRefresh = options.forceInvoiceRefresh === true;
  const intentKey = [
    sourceState?.custody?.entityId || '',
    sourceState?.custody?.jurisdictionId || '',
    sourceState?.session?.userId || '',
    String(tokenId),
    String(amount || '').trim(),
  ].join('|');
  if (intentKey !== pendingDepositIntentKey || forceInvoiceRefresh) {
    pendingDepositIntentKey = intentKey;
    pendingDepositInvoiceId = createInvoiceId();
    pendingInvoice = buildInvoiceUri(sourceState, tokenId, amount, pendingDepositInvoiceId);
    pendingWalletHref = buildWalletPayHref(sourceState, tokenId, amount, pendingDepositInvoiceId);
    pendingQrSrc = `/api/qr?data=${encodeURIComponent(pendingInvoice)}`;
  }
};

const renderActivity = () => {
  if (!state || state.activity.length === 0) {
    return '<div class="empty-activity">No deposits or withdrawals yet.</div>';
  }

  return `<div class="activity-list">${state.activity.map((item) => {
    const badge = item.kind === 'deposit' ? 'IN' : 'OUT';
    const status = item.error ? `${item.status} · ${escapeHtml(item.error)}` : item.status;
    const amountLine = item.kind === 'withdrawal' && item.feeDisplay
      ? `${escapeHtml(item.requestedAmountDisplay || item.amountDisplay)} sent · fee ${escapeHtml(item.feeDisplay)}`
      : escapeHtml(item.amountDisplay);
    return `
      <div class="activity-row">
        <div class="activity-badge ${item.kind}">${badge}</div>
        <div>
          <div class="activity-title">${item.kind === 'deposit' ? 'Deposit credited' : 'Withdrawal queued'}</div>
          <div class="activity-sub">${escapeHtml(shortId(item.counterpartyEntityId))} · frame ${item.frameHeight ?? 'pending'}</div>
        </div>
        <div class="activity-amount">
          <div class="amount-value">${amountLine}</div>
          <div class="status-text">${escapeHtml(status)}</div>
        </div>
      </div>
    `;
  }).join('')}</div>`;
};

const renderIntegration = () => {
  if (!state) return '';
  const daemon = state.custody.daemonWsUrl;
  const signer = state.custody.signerId || '<daemon resolves proposer signer>';
  return `
    <section class="integration-section">
      <h2>How to integrate</h2>
      <div class="hint">This custody service stores sessions and balances locally. Everything financial goes through one XLN daemon over websocket.</div>
      <div class="integration-list">
        <div class="integration-step">
          <div class="step-title">1. Start the XLN daemon</div>
          <pre class="activity-sub">bun runtime/server.ts --port 8080</pre>
          <div class="activity-sub">Custody backend talks to <code>${escapeHtml(daemon)}</code> using the daemon's frame journal as source of truth.</div>
        </div>
        <div class="integration-step">
          <div class="step-title">2. Run custody against one entity</div>
          <pre class="activity-sub">CUSTODY_ENTITY_ID=${escapeHtml(state.custody.entityId)}
CUSTODY_SIGNER_ID=${escapeHtml(signer)}
CUSTODY_DAEMON_WS=${escapeHtml(daemon)}
CUSTODY_WALLET_URL=${escapeHtml(state.custody.walletUrl)}
bun custody/server.ts</pre>
        </div>
        <div class="integration-step">
          <div class="step-title">3. Deposit flow</div>
          <div class="activity-sub">Custody generates a signed XLN invoice. User scans the QR, copies the invoice, or opens the wallet directly on the prefilled pay screen.</div>
        </div>
        <div class="integration-step">
          <div class="step-title">4. Crediting</div>
          <div class="activity-sub">Backend polls <code>get_frame_receipts</code>, scans <code>HtlcReceived</code> events, extracts <code>uid:&lt;user&gt;</code> from description, credits balance exactly once.</div>
        </div>
        <div class="integration-step">
          <div class="step-title">5. Withdrawal</div>
          <div class="activity-sub">Backend reserves balance, calls <code>queue_payment</code>, finalizes or restores when <code>PaymentFinalized</code> or <code>PaymentFailed</code> events appear.</div>
        </div>
      </div>
    </section>
  `;
};

const render = () => {
  if (!state) {
    app.innerHTML = '<div class="loading-card"><div class="pulse"></div><p>Loading custody dashboard...</p></div>';
    return;
  }

  const activeField = captureActiveField();
  const selectedDepositToken = getSelectedDepositToken();

  const tokenColors = {
    USDC: '#2775ca',
    WETH: '#627eea',
    USDT: '#26a17b',
  };

  app.innerHTML = `
    <header class="page-header">
      <div>
        <h1>${escapeHtml(state.custody.name)}</h1>
        <p class="sub">Deposit from XLN, keep balances locally, withdraw through the cheapest route.</p>
      </div>
      <div class="status-pill ${state.custody.connected ? 'ok' : 'error'}">
        <span class="dot"></span>
        ${state.custody.connected ? 'Connected' : 'Disconnected'}
      </div>
    </header>

    <div class="token-grid">
      ${state.tokens.map((token) => {
        const bg = tokenColors[token.symbol] || token.accent;
        return `
          <div class="token-card">
            <div class="token-header">
              <div class="token-icon" style="background: ${escapeHtml(bg)};">${escapeHtml(token.symbol.slice(0, 1))}</div>
              <div>
                <div class="token-name">${escapeHtml(token.symbol)}</div>
                <div class="token-full-name">${escapeHtml(token.name)}</div>
              </div>
            </div>
            <div class="token-balance">${escapeHtml(token.amountDisplay)}</div>
            <div class="token-minor">${escapeHtml(token.symbol)} balance</div>
          </div>
        `;
      }).join('')}
    </div>

    ${state.custody.lastSyncError ? `<div class="inline-error" style="margin-bottom:16px;">${escapeHtml(state.custody.lastSyncError)}</div>` : ''}

    <div class="action-grid">
      <section class="action-card">
        <h2>Deposit</h2>
        <div class="action-sub">Scan the QR, copy the payment request, or open it directly in your wallet.</div>
        <form id="deposit-form">
          <label>
            Asset
            <select name="depositTokenId">
              ${state.tokens.map(token => `<option value="${token.tokenId}" ${token.tokenId === depositTokenId ? 'selected' : ''}>${escapeHtml(token.symbol)}</option>`).join('')}
            </select>
          </label>
          <label>
            Amount
            <input name="depositAmount" inputmode="decimal" aria-label="Deposit amount" value="${escapeHtml(depositAmount)}" required />
          </label>
          <div class="deposit-presets">
            ${['1', '10', '100'].map(value => `<button class="secondary" type="button" data-deposit-preset="${value}">${escapeHtml(value)} ${escapeHtml(selectedDepositToken?.symbol || 'USDC')}</button>`).join('')}
          </div>
          <div class="deposit-invoice-card">
            <div class="deposit-qr-wrap">
              ${pendingQrSrc ? `<img class="deposit-qr-image" src="${escapeHtml(pendingQrSrc)}" alt="XLN invoice QR" />` : '<div class="deposit-qr-placeholder">Generating QR…</div>'}
            </div>
            <div class="deposit-invoice-details">
              <div class="deposit-invoice-row">
                <div class="deposit-invoice-text deposit-invoice-string">${escapeHtml(pendingInvoice)}</div>
              </div>
              <div class="deposit-actions-row">
                <button class="btn-xln-action" type="button" data-open-wallet-href="${escapeHtml(pendingWalletHref)}">
                  <span class="btn-xln-mark" aria-hidden="true">
                    <img src="https://xln.finance/img/logo.png" alt="" />
                  </span>
                  <span>Local Wallet</span>
                </button>
                <button
                  class="deposit-copy-inline"
                  type="button"
                  data-copy-invoice="${escapeHtml(pendingInvoice)}"
                  data-default-label="Copy invoice"
                  data-copied-label="Copied"
                >Copy invoice</button>
              </div>
            </div>
          </div>
        </form>
      </section>

      <section class="action-card">
        <h2>Withdraw</h2>
        <div class="action-sub">Send funds to any XLN entity. Route and fee resolved automatically.</div>
        <form id="withdraw-form">
          <label>
            Asset
            <select name="tokenId">
              ${state.tokens.map(token => `<option value="${token.tokenId}" ${token.tokenId === selectedTokenId ? 'selected' : ''}>${escapeHtml(token.symbol)}</option>`).join('')}
            </select>
          </label>
          <label>
            Amount
            <input name="amount" inputmode="decimal" aria-label="Withdraw amount" value="${escapeHtml(withdrawAmount)}" required />
          </label>
          <label>
            Invoice or entity id
            <input
              name="targetEntityId"
              aria-label="Withdraw destination"
              autocomplete="off"
              value="${escapeHtml(withdrawTargetEntityId)}"
              required
            />
          </label>
          <div class="form-foot">
            <div class="hint">Balance debited by requested payout plus route fee.</div>
            ${withdrawError ? `<div class="inline-error">${escapeHtml(withdrawError)}</div>` : ''}
            ${withdrawMessage ? `<div class="inline-ok">${escapeHtml(withdrawMessage)}</div>` : ''}
            <div class="checkout-cta-group">
              <button class="btn-xln-action full-width" type="submit" ${submitting ? 'disabled' : ''}>
                <span class="btn-xln-mark" aria-hidden="true">
                  <img src="https://xln.finance/img/logo.png" alt="" />
                </span>
                <span>Withdraw</span>
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>

    <section class="activity-section">
      <h2>Recent activity</h2>
      ${renderActivity()}
    </section>

    <div class="meta-footer">
      <div class="meta-cell">
        <div class="meta-label">Session</div>
        <div class="meta-value">${escapeHtml(state.session.userId)}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-label">Custody entity</div>
        <div class="meta-value">${escapeHtml(shortId(state.custody.entityId))}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-label">Jurisdiction</div>
        <div class="meta-value">${escapeHtml(state.custody.jurisdictionId || 'n/a')}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-label">Last sync</div>
        <div class="meta-value">${escapeHtml(formatTime(state.custody.lastSyncOkAt))}</div>
      </div>
    </div>

    ${renderIntegration()}
  `;

  const form = document.getElementById('withdraw-form');
  if (form instanceof HTMLFormElement) {
    form.addEventListener('submit', handleWithdrawSubmit);
    const tokenSelect = form.elements.namedItem('tokenId');
    if (tokenSelect instanceof HTMLSelectElement) {
      tokenSelect.addEventListener('change', () => {
        selectedTokenId = Number(tokenSelect.value || '1');
        render();
      });
    }
    const amountInput = form.elements.namedItem('amount');
    if (amountInput instanceof HTMLInputElement) {
      amountInput.addEventListener('input', () => {
        withdrawAmount = amountInput.value;
      });
    }
    const targetInput = form.elements.namedItem('targetEntityId');
    if (targetInput instanceof HTMLInputElement) {
      targetInput.addEventListener('input', () => {
        withdrawTargetEntityId = targetInput.value;
      });
    }
  }

  const depositForm = document.getElementById('deposit-form');
  if (depositForm instanceof HTMLFormElement) {
    depositForm.addEventListener('submit', handleDepositSubmit);
    const depositTokenSelect = depositForm.elements.namedItem('depositTokenId');
    if (depositTokenSelect instanceof HTMLSelectElement) {
        depositTokenSelect.addEventListener('change', () => {
          depositTokenId = Number(depositTokenSelect.value || '1');
          syncDepositTargets(depositTokenId, depositAmount || '0');
          render();
        });
    }
    const depositAmountInput = depositForm.elements.namedItem('depositAmount');
    if (depositAmountInput instanceof HTMLInputElement) {
      depositAmountInput.addEventListener('input', () => {
        depositAmount = depositAmountInput.value;
        syncDepositTargets(depositTokenId, depositAmount || '0');
        render();
      });
    }
    depositForm.querySelectorAll('[data-deposit-preset]').forEach((button) => {
      button.addEventListener('click', () => {
        const presetValue = button.getAttribute('data-deposit-preset') || '10';
        depositAmount = presetValue;
        syncDepositTargets(depositTokenId, depositAmount);
        render();
      });
    });
    const openWalletButton = depositForm.querySelector('[data-open-wallet-href]');
    if (openWalletButton instanceof HTMLButtonElement) {
      openWalletButton.addEventListener('click', () => {
        const href = openWalletButton.getAttribute('data-open-wallet-href') || '';
        if (!href) return;
        const popup = window.open(href, WALLET_WINDOW_NAME);
        popup?.focus();
      });
    }
    const copyInvoiceButton = depositForm.querySelector('[data-copy-invoice]');
    if (copyInvoiceButton instanceof HTMLButtonElement) {
      copyInvoiceButton.addEventListener('click', async () => {
        const invoice = copyInvoiceButton.getAttribute('data-copy-invoice') || '';
        if (!invoice) return;
        await navigator.clipboard.writeText(invoice);
        depositHint = '';
        updateDepositHintUi();
        const defaultLabel = copyInvoiceButton.getAttribute('data-default-label') || 'Copy invoice';
        const copiedLabel = copyInvoiceButton.getAttribute('data-copied-label') || 'Copied';
        copyInvoiceButton.textContent = copiedLabel;
        if (copyInvoiceResetTimer) {
          clearTimeout(copyInvoiceResetTimer);
        }
        copyInvoiceResetTimer = setTimeout(() => {
          copyInvoiceButton.textContent = defaultLabel;
          copyInvoiceResetTimer = null;
        }, 1200);
      });
    }
  }

  restoreActiveField(activeField);
};

const dashboardFingerprint = (payload) => JSON.stringify({
  custody: {
    connected: payload?.custody?.connected ?? false,
    lastSyncError: payload?.custody?.lastSyncError ?? null,
  },
  headlineBalance: payload?.headlineBalance ?? null,
  tokens: (payload?.tokens ?? []).map((token) => ({
    tokenId: token.tokenId,
    amountMinor: token.amountMinor,
    amountDisplay: token.amountDisplay,
  })),
  activity: payload?.activity ?? [],
});

const applyDashboardState = (nextState, forceRender = false) => {
  const nextFingerprint = dashboardFingerprint(nextState);
  const shouldRender = forceRender || nextFingerprint !== lastDashboardFingerprint;
  state = nextState;
  if (!state.tokens.some((token) => token.tokenId === selectedTokenId)) {
    selectedTokenId = state.tokens[0]?.tokenId || 1;
  }
  if (!state.tokens.some((token) => token.tokenId === depositTokenId)) {
    depositTokenId = state.tokens[0]?.tokenId || 1;
  }
  if (shouldRender) {
    lastDashboardFingerprint = nextFingerprint;
    render();
  }
};

const load = async () => {
  const response = await fetch('/api/me', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Failed to load dashboard (${response.status})`);
  }
  const payload = await response.json();
  selectedTokenId = payload.tokens[0]?.tokenId || 1;
  depositTokenId = payload.tokens[0]?.tokenId || 1;
  syncDepositTargets(depositTokenId, depositAmount || '10', payload);
  applyDashboardState(payload, true);
};

const reload = async () => {
  const response = await fetch('/api/me', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Failed to refresh dashboard (${response.status})`);
  }
  applyDashboardState(await response.json());
};

async function handleDepositSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const formData = new FormData(form);
  const tokenId = Number(formData.get('depositTokenId') || String(depositTokenId || 1));
  const amount = String(formData.get('depositAmount') || depositAmount || '').trim();
  if (!amount) {
    return;
  }
  depositTokenId = tokenId;
  depositAmount = amount;
  syncDepositTargets(tokenId, amount);
  depositHint = 'Deposit options updated.';
  render();
}

async function handleWithdrawSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const formData = new FormData(form);
  withdrawMessage = '';
  withdrawError = '';
  submitting = true;
  withdrawAmount = String(formData.get('amount') || '').trim();
  withdrawTargetEntityId = String(formData.get('targetEntityId') || '').trim();
  selectedTokenId = Number(formData.get('tokenId') || String(selectedTokenId || 1));
  render();

  try {
    const parsedIntent = parsePaymentIntent(withdrawTargetEntityId);
    const resolvedTargetEntityId = parsedIntent?.entityId || withdrawTargetEntityId;
    if (!/^0x[0-9a-f]{64}$/i.test(resolvedTargetEntityId)) {
      throw new Error('Enter a valid XLN invoice or destination entity id');
    }
    if (parsedIntent?.tokenId) {
      selectedTokenId = parsedIntent.tokenId;
    }
    if (parsedIntent?.amount) {
      withdrawAmount = parsedIntent.amount;
    }
    const response = await fetch('/api/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenId: selectedTokenId,
        amount: withdrawAmount,
        targetEntityId: resolvedTargetEntityId,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error || `Withdrawal failed (${response.status})`);
    }
    const feeSuffix = payload.feeAmountDisplay ? ` · fee ${payload.feeAmountDisplay}` : '';
    withdrawMessage = `Queued withdrawal ${payload.withdrawalId}${feeSuffix}`;
    withdrawError = '';
    withdrawAmount = '';
    withdrawTargetEntityId = '';
    form.reset();
    if (state) selectedTokenId = state.tokens[0]?.tokenId || selectedTokenId;
    await reload();
  } catch (error) {
    withdrawError = error instanceof Error ? error.message : String(error);
    await reload().catch(() => undefined);
  } finally {
    submitting = false;
    render();
  }
}

load().catch((error) => {
  app.innerHTML = `<div class="error-card"><h2>Custody dashboard failed</h2><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div>`;
});

setInterval(() => {
  void reload().catch(() => undefined);
}, 2000);
