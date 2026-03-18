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
let pendingPayButtonHref = '';
let pendingFindRoutesHref = '';
let pendingDepositIntentKey = '';
let pendingDepositInvoiceId = '';
let embeddedCheckoutStatus = '';
let embeddedCheckoutError = '';
let embeddedCheckoutStage = 'Waiting for wallet boot...';
let lastDashboardFingerprint = '';
/** @type {HTMLIFrameElement | null} */
let payControllerFrame = null;
const FIND_ROUTES_WINDOW_NAME = 'xln-custody-find-routes';

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

const buildWalletPayHref = (sourceState, tokenId, amount, invoiceId) => {
  if (!sourceState?.custody?.walletUrl) return '';
  const base = new URL(sourceState.custody.walletUrl);
  const url = new URL('/app', base.origin);
  const params = new URLSearchParams();
  params.set('id', sourceState.custody.entityId);
  params.set('token', String(tokenId));
  params.set('amt', String(amount).trim());
  params.set('u', sourceState.session.userId);
  params.set('desc', `Custody invoice:${invoiceId}`);
  params.set('locked', '1');
  if (sourceState.custody.jurisdictionId) {
    params.set('jId', sourceState.custody.jurisdictionId);
  }
  url.hash = `pay?${params.toString()}`;
  return url.toString();
};

const buildEmbeddedButtonHref = (sourceState, tokenId, amount) => {
  return buildEmbeddedButtonHrefWithInvoice(sourceState, tokenId, amount, createInvoiceId());
};

const buildEmbeddedButtonHrefWithInvoice = (sourceState, tokenId, amount, invoiceId) => {
  if (!sourceState?.custody?.walletUrl) return '';
  const base = new URL(sourceState.custody.walletUrl);
  const url = new URL('/app', base.origin);
  url.searchParams.set('e', '1');
  const params = new URLSearchParams();
  params.set('id', sourceState.custody.entityId);
  params.set('token', String(tokenId));
  params.set('amt', String(amount).trim());
  params.set('u', sourceState.session.userId);
  params.set('desc', `Custody invoice:${invoiceId}`);
  params.set('locked', '1');
  params.set('mode', 'embed');
  params.set('segment', 'left');
  params.set('parentOrigin', window.location.origin);
  if (sourceState.custody.jurisdictionId) {
    params.set('jId', sourceState.custody.jurisdictionId);
  }
  url.hash = `pay?${params.toString()}`;
  return url.toString();
};

const ensurePayControllerFrame = () => {
  if (payControllerFrame) return payControllerFrame;
  const iframe = document.createElement('iframe');
  iframe.className = 'paybutton-controller-frame';
  iframe.setAttribute('title', 'xln pay controller');
  iframe.setAttribute('loading', 'eager');
  iframe.setAttribute('referrerpolicy', 'origin');
  payControllerFrame = iframe;
  return iframe;
};

const postEmbeddedIntentUpdate = (tokenId, amount, invoiceId = pendingDepositInvoiceId, sourceState = state) => {
  if (!payControllerFrame?.contentWindow || !sourceState?.custody?.walletUrl) return false;
  let targetOrigin = '';
  try {
    targetOrigin = new URL(sourceState.custody.walletUrl).origin;
  } catch {
    return false;
  }
  if (!targetOrigin) return false;
  const description = `Custody invoice:${invoiceId}`;
  payControllerFrame.contentWindow.postMessage({
    source: 'xln-custody',
    command: 'update-intent',
    entityId: String(sourceState?.custody?.entityId || '').trim(),
    tokenId: String(tokenId),
    amount: String(amount || '').trim(),
    userId: String(sourceState?.session?.userId || '').trim(),
    jurisdictionId: String(sourceState?.custody?.jurisdictionId || '').trim(),
    description,
  }, targetOrigin);
  return true;
};

const patchEmbeddedDepositUi = () => {
  const note = app.querySelector('.action-note');
  if (note instanceof HTMLDivElement) {
    note.textContent = embeddedCheckoutError
      ? 'Payment failed. Check the embedded wallet and retry.'
      : (embeddedCheckoutStatus || 'Left side prepares and pays inside the embedded wallet. Right side opens the full wallet to choose a route manually.');
  }
  const status = app.querySelector('.deposit-status-line');
  if (status instanceof HTMLDivElement) {
    status.textContent = embeddedCheckoutError || embeddedCheckoutStage || embeddedCheckoutStatus || 'Waiting for wallet boot...';
    status.dataset.state = embeddedCheckoutError
      ? 'error'
      : (String(embeddedCheckoutStage || '').toLowerCase().includes('pay via') || String(embeddedCheckoutStatus || '').toLowerCase().includes('confirmed'))
        ? 'ready'
        : 'loading';
  }
  let inlineError = app.querySelector('.deposit-inline-error');
  if (embeddedCheckoutError) {
    if (!(inlineError instanceof HTMLDivElement)) {
      inlineError = document.createElement('div');
      inlineError.className = 'inline-error deposit-inline-error';
      const form = document.getElementById('deposit-form');
      form?.appendChild(inlineError);
    }
    inlineError.textContent = embeddedCheckoutError;
  } else if (inlineError instanceof HTMLDivElement) {
    inlineError.remove();
  }
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
    const hadIntent = Boolean(pendingDepositIntentKey);
    pendingDepositIntentKey = intentKey;
    pendingDepositInvoiceId = createInvoiceId();
    pendingPayButtonHref = buildEmbeddedButtonHrefWithInvoice(sourceState, tokenId, amount, pendingDepositInvoiceId);
    pendingFindRoutesHref = buildWalletPayHref(sourceState, tokenId, amount, pendingDepositInvoiceId);
    if (hadIntent && payControllerFrame) {
      embeddedCheckoutStatus = '';
      embeddedCheckoutError = '';
      embeddedCheckoutStage = 'Loading wallet...';
      const updated = postEmbeddedIntentUpdate(tokenId, amount, pendingDepositInvoiceId, sourceState);
      if (!updated) {
        try {
          payControllerFrame.src = pendingPayButtonHref;
        } catch {
          // ignore reload errors; next render will reconcile src
        }
      }
    }
  }
  const iframe = ensurePayControllerFrame();
  if (!iframe.src || iframe.src === 'about:blank') {
    embeddedCheckoutStatus = '';
    embeddedCheckoutError = '';
    embeddedCheckoutStage = 'Loading wallet...';
    iframe.src = pendingPayButtonHref;
  }
  const findRoutesButton = app.querySelector('.deposit-find-routes-btn');
  if (findRoutesButton instanceof HTMLButtonElement) {
    findRoutesButton.setAttribute('data-find-routes-href', pendingFindRoutesHref);
  }
};

const handleCheckoutMessage = (event) => {
  let expectedOrigin = '';
  try {
    expectedOrigin = new URL(state?.custody?.walletUrl || '').origin;
  } catch {
    expectedOrigin = '';
  }
  if (!expectedOrigin || event.origin !== expectedOrigin) return;

  const payload = event.data || {};
  if (payload.source !== 'xln-hosted-checkout' && payload.source !== 'xln-embedded-pay') return;

  if (payload.event === 'checkout-ready') {
    console.info('[custody.embed.checkout]', payload);
    embeddedCheckoutStatus = String(payload.status || '').trim() || 'Loading';
    embeddedCheckoutStage = embeddedCheckoutStatus || 'Loading wallet...';
    embeddedCheckoutError = '';
    patchEmbeddedDepositUi();
    return;
  }

  if (payload.event === 'payment-error') {
    console.error('[custody.embed.checkout]', payload);
    embeddedCheckoutStatus = '';
    embeddedCheckoutError = String(payload.message || 'Embedded payment failed');
    embeddedCheckoutStage = embeddedCheckoutError;
    patchEmbeddedDepositUi();
    return;
  }

  if (payload.event === 'payment-success') {
    console.info('[custody.embed.checkout]', payload);
    embeddedCheckoutStatus = 'Paid';
    embeddedCheckoutError = '';
    embeddedCheckoutStage = 'Paid';
    patchEmbeddedDepositUi();
    setTimeout(() => {
      syncDepositTargets(depositTokenId, depositAmount || '0', state, { forceInvoiceRefresh: true });
      void reload().catch(() => undefined);
    }, 1100);
    return;
  }

  if (payload.event === 'checkout-close') {
    patchEmbeddedDepositUi();
  }
};

const handleEmbeddedPayState = (payload) => {
  console.info('[custody.embed.state]', payload);
  embeddedCheckoutStatus = String(payload.statusText || '');
  embeddedCheckoutError = String(payload.error || '');
  embeddedCheckoutStage = String(payload.label || payload.statusText || '').trim() || 'Loading wallet...';
  patchEmbeddedDepositUi();
};

const isEmbeddedPayBusy = () => {
  const frameSrc = String(payControllerFrame?.src || '').trim();
  if (!frameSrc || frameSrc === 'about:blank') return false;
  const stage = String(embeddedCheckoutStage || '').trim().toLowerCase();
  if (!stage) return false;
  return (
    stage.includes('loading') ||
    stage.includes('finding routes') ||
    stage.includes('preparing') ||
    stage.includes('paying') ||
    stage.includes('authorizing')
  );
};

const handlePaymentFrameMessage = (event) => {
  let expectedOrigin = '';
  try {
    expectedOrigin = new URL(state?.custody?.walletUrl || '').origin;
  } catch {
    expectedOrigin = '';
  }
  if (!expectedOrigin || event.origin !== expectedOrigin) return;
  const payload = event.data || {};
  if (payload.source === 'xln-embedded-pay') {
    if (payload.event === 'state') {
      handleEmbeddedPayState(payload);
      return;
    }
    if (payload.event === 'payment-success' || payload.event === 'payment-error') {
      handleCheckoutMessage(event);
      return;
    }
    return;
  }
  handleCheckoutMessage(event);
};

window.addEventListener('message', handlePaymentFrameMessage);

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
          <div class="activity-sub">User clicks the embedded XLN button. It already knows the target entity, amount, token, jurisdiction, and user id from the iframe URL and executes the payment in place.</div>
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
  const withdrawButtonLabel = submitting ? 'Sending...' : 'Withdraw via xln';
  const payButtonHref = pendingPayButtonHref;
  const findRoutesHref = pendingFindRoutesHref;

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
        <div class="action-sub">Pay directly to this custody entity. Left button pays immediately. Right button opens the wallet so the user can choose a route manually.</div>
        <form id="deposit-form">
          <label>
            Asset
            <select name="depositTokenId">
              ${state.tokens.map(token => `<option value="${token.tokenId}" ${token.tokenId === depositTokenId ? 'selected' : ''}>${escapeHtml(token.symbol)}</option>`).join('')}
            </select>
          </label>
          <label>
            Amount
            <input name="depositAmount" inputmode="decimal" placeholder="10" value="${escapeHtml(depositAmount)}" required />
          </label>
          <div class="deposit-presets">
            ${['1', '10', '100'].map(value => `<button class="secondary" type="button" data-deposit-preset="${value}">${escapeHtml(value)} ${escapeHtml(selectedDepositToken?.symbol || 'USDC')}</button>`).join('')}
          </div>
          <div class="deposit-cta-group segmented">
            <div class="deposit-cta-segment left">
              <div class="deposit-controller-host" aria-label="Embedded Pay Controller"></div>
            </div>
            <div class="deposit-cta-divider" aria-hidden="true"></div>
            <div class="deposit-cta-segment right">
              <button
                class="deposit-find-routes-btn"
                type="button"
                data-find-routes-href="${escapeHtml(findRoutesHref)}"
              >
                <span>Find Routes</span>
              </button>
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
            <input name="amount" inputmode="decimal" placeholder="10" value="${escapeHtml(withdrawAmount)}" required />
          </label>
          <label>
            Destination entity id
            <input
              name="targetEntityId"
              placeholder="0x..."
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
              <button class="primary full-width" type="submit" ${submitting ? 'disabled' : ''}>Withdraw via XLN</button>
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
    const findRoutesButton = depositForm.querySelector('.deposit-find-routes-btn');
    if (findRoutesButton instanceof HTMLButtonElement) {
      findRoutesButton.addEventListener('click', () => {
        const href = findRoutesButton.getAttribute('data-find-routes-href') || '';
        if (!href) return;
        embeddedCheckoutStatus = '';
        embeddedCheckoutError = '';
        embeddedCheckoutStage = 'Manual route selection';
        patchEmbeddedDepositUi();
        if (payControllerFrame) {
          try {
            payControllerFrame.src = 'about:blank';
          } catch {
            // ignore
          }
        }
        const popup = window.open(href, FIND_ROUTES_WINDOW_NAME);
        popup?.focus();
      });
    }
  }

  const controllerHost = app.querySelector('.deposit-controller-host');
  if (controllerHost instanceof HTMLDivElement) {
    const frame = ensurePayControllerFrame();
    if (payButtonHref && frame.src !== payButtonHref) {
      frame.src = payButtonHref;
    }
    controllerHost.replaceChildren(frame);
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
  embeddedCheckoutStatus = 'Wallet ready';
  embeddedCheckoutError = '';
  embeddedCheckoutStage = 'Wallet ready';
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
    const response = await fetch('/api/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenId: selectedTokenId,
        amount: withdrawAmount,
        targetEntityId: withdrawTargetEntityId,
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
  if (isEmbeddedPayBusy()) return;
  void reload().catch(() => undefined);
}, 2000);
