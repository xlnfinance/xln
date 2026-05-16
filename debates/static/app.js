const app = document.querySelector('#app');

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

let dashboard = null;
let currentChallenge = null;
let errorText = '';
let depositInfo = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed: ${path}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function money(balance, field = 'availableDisplay') {
  return `${escapeHtml(balance[field] || '0')} ${escapeHtml(balance.symbol)}`;
}

function shortId(value) {
  const raw = String(value || '');
  return raw.length > 14 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : raw;
}

function routeSlug() {
  const match = location.pathname.match(/^\/c\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function load() {
  const me = await api('/api/me');
  dashboard = me;
  const slug = routeSlug();
  if (slug) {
    try {
      const detail = await api(`/api/challenges/${encodeURIComponent(slug)}`);
      currentChallenge = detail.challenge;
    } catch (error) {
      currentChallenge = null;
      errorText = `Challenge not found or expired in local dev DB. Create a new one.`;
      history.replaceState({}, '', '/');
    }
  } else {
    currentChallenge = null;
  }
  render();
}

function shell(main) {
  const balances = dashboard.balances.map(balance => `
    <div class="metric ${Number(balance.lockedMinor) > 0 ? 'escrow-pulse' : ''}">
      <span>${escapeHtml(balance.symbol)}</span>
      <strong data-testid="balance-${escapeHtml(balance.symbol)}">${money(balance)}</strong>
      <small class="tiny">locked ${money(balance, 'lockedDisplay')}</small>
    </div>
  `).join('');
  const mine = dashboard.myChallenges.slice(0, 8).map(challenge => `
    <a class="feed-row" href="/c/${encodeURIComponent(challenge.slug)}">
      <strong>${escapeHtml(challenge.statement)}</strong>
      <span class="tiny">${escapeHtml(challenge.status)} · ${escapeHtml(challenge.stakeDisplay)} ${escapeHtml(challenge.tokenSymbol)}</span>
    </a>
  `).join('');
  const publicFeed = dashboard.publicChallenges.slice(0, 8).map(challenge => `
    <a class="feed-row" href="/c/${encodeURIComponent(challenge.slug)}">
      <strong>${escapeHtml(challenge.statement)}</strong>
      <span class="tiny">${escapeHtml(challenge.status)} · ${challenge.roundsTotal} rounds${challenge.verdictSummary ? ` · ${escapeHtml(challenge.verdictSummary)}` : ''}</span>
    </a>
  `).join('');
  const ledger = dashboard.ledger.slice(0, 8).map(row => `
    <div class="ledger-row">
      <span>${escapeHtml(row.reason)}</span>
      <span class="tiny">${escapeHtml(row.tokenSymbol)} available ${escapeHtml(row.deltaAvailableMinor)}</span>
    </div>
  `).join('');

  return `
    <div class="product-shell">
      <header class="topbar">
        <a class="brand" href="/">
          <div class="brand-mark">X</div>
          <div>
            <h1>XLN Debates</h1>
            <small>AI-judged challenge arena</small>
          </div>
        </a>
        <div class="top-metrics">${balances}</div>
        <div class="session-chip"><span class="dot"></span>${dashboard.service.offlineXln ? 'offline XLN' : 'XLN live'} · ${escapeHtml(shortId(dashboard.session.userId))}</div>
      </header>
      <div class="workspace">
        <main class="main">${main}</main>
        <aside class="side">
          <section class="surface tight">
            <div class="section-title">
              <h2>XLN Wallet</h2>
              <span class="pill">${dashboard.service.daemonEnabled ? 'daemon' : 'dev'}</span>
            </div>
            <div class="wallet-command">
              <button class="primary" data-action="deposit-instructions" data-testid="deposit-instructions">Deposit via XLN</button>
              ${dashboard.service.devMode ? '<button data-action="dev-fund" data-testid="dev-fund">Dev credit +250 USDC</button>' : ''}
              ${dashboard.service.devMode ? '<button data-action="seed-demo" data-testid="seed-demo">Load 5 finalized debates</button>' : ''}
              ${depositInfo ? `
                <div class="deposit-box" data-testid="deposit-box">
                  <div class="tiny">Send ${escapeHtml(depositInfo.token.symbol)} to service entity</div>
                  <div class="mono">${escapeHtml(depositInfo.serviceEntityId)}</div>
                  <div class="tiny">Description</div>
                  <div class="mono">${escapeHtml(depositInfo.description)}</div>
                </div>
              ` : ''}
              <div class="tiny">daemon ${dashboard.service.daemonConnected ? 'connected' : 'not connected'} · ${dashboard.service.offlineXln ? 'offline mode' : 'live XLN'}</div>
            </div>
          </section>
          <section class="surface tight">
            <div class="section-title">
              <h2>My Debates</h2>
              <span class="pill">${dashboard.myChallenges.length}</span>
            </div>
            ${mine || '<div class="empty">No active debates.</div>'}
          </section>
          <section class="surface tight">
            <div class="section-title">
              <h2>Public Arena</h2>
              <span class="pill">${dashboard.publicChallenges.length}</span>
            </div>
            ${publicFeed || '<div class="empty">Create the first public challenge.</div>'}
          </section>
          <section class="surface tight">
            <div class="section-title">
              <h2>Judge Boards</h2>
            </div>
            <div class="judge-grid">
              <div class="judge"><strong>Classic 3</strong><div class="tiny">Logic · Evidence · Clarity</div></div>
              <div class="judge"><strong>Technical 5</strong><div class="tiny">Systems · Security · Product · Cost · Chair</div></div>
            </div>
          </section>
          <section class="surface tight">
            <div class="section-title">
              <h2>Ledger</h2>
            </div>
            ${ledger || '<div class="empty">No balance movement yet.</div>'}
          </section>
        </aside>
      </div>
    </div>
  `;
}

function homeView() {
  return shell(`
    <div class="toolbar">
      <div>
        <div class="status">challenge composer</div>
        <h2 style="font-size:24px;margin:4px 0 0">Create Debate</h2>
      </div>
      <a class="pill" href="/">debates.xln.finance</a>
    </div>
    <section class="surface composer">
      <form data-action="create-challenge">
        <div class="court-banner">
          <strong>Two-party court mode</strong>
          <span>Side A files the claim. Side B joins from the invite link. Judges score each side out of 1000 and decide by margin.</span>
        </div>
        <label>Statement
          <textarea data-testid="statement" name="statement">Linux is better than Windows for professional developers.</textarea>
        </label>
        <div class="grid-2">
          <label>Side A
            <input data-testid="side-a" name="sideALabel" value="Linux is the stronger professional workstation" />
          </label>
          <label>Side B
            <input data-testid="side-b" name="sideBLabel" value="Windows is the stronger professional workstation" />
          </label>
        </div>
        <label>Context
          <textarea data-testid="context" name="contextText">Compare reliability, developer tooling, security posture, cost, gaming, enterprise support, and hardware compatibility.</textarea>
        </label>
        <div class="grid-3">
          <label>Stake
            <input data-testid="stake" name="stake" value="10" />
          </label>
          <label>Token
            <select data-testid="token" name="tokenId">
              <option value="1">USDC</option>
              <option value="3">USDT</option>
            </select>
          </label>
          <label>Rounds
            <select data-testid="rounds" name="roundsTotal">
              <option>1</option>
              <option selected>3</option>
              <option>5</option>
            </select>
          </label>
        </div>
        <div class="grid-3">
          <label>Message limit
            <input data-testid="limit" name="messageLimitChars" value="1200" />
          </label>
          <label>Judge board
            <select data-testid="board" name="boardId">
              <option value="classic3">Classic 3</option>
              <option value="technical5">Technical 5</option>
            </select>
          </label>
          <label>Rules
            <select name="rulesTemplate">
              <option>General Debate</option>
              <option>Technical Comparison</option>
              <option>Product Decision</option>
            </select>
          </label>
        </div>
        <label>Custom rules
          <textarea name="customRules">No personal attacks. Judge only the claims made in the transcript and supplied context.</textarea>
        </label>
        <button class="primary" data-testid="create-challenge">Create challenge</button>
        <div class="error">${escapeHtml(errorText)}</div>
      </form>
    </section>
  `);
}

function challengeView(challenge) {
  const invite = challenge.inviteUrl
    ? `${location.origin}${challenge.inviteUrl}`
    : '';
  const messages = challenge.messages.map(message => `
    <article class="message ${message.side.toLowerCase()}">
      <div class="message-head">
        <span>Round ${message.roundNumber} · Side ${message.side}</span>
        <span>${escapeHtml(shortId(message.bodyHash))}</span>
      </div>
      <div class="message-body">${escapeHtml(message.body)}</div>
    </article>
  `).join('');
  const judges = challenge.judgeBoard.map(judge => `
    <div class="judge">
      <strong>${escapeHtml(judge.label)}</strong>
      <div class="tiny">${escapeHtml(judge.model)} · ${escapeHtml(judge.provider)}</div>
    </div>
  `).join('');
  const judgeResults = challenge.judgeRuns?.length ? challenge.judgeRuns.map(run => {
    const verdict = run.verdict;
    if (!verdict) return '';
    const a = verdict.scores1000?.A ?? (verdict.scores?.A || 0) * 10;
    const b = verdict.scores1000?.B ?? (verdict.scores?.B || 0) * 10;
    return `
      <div class="score-row">
        <strong>${escapeHtml(run.judgeId)}</strong>
        <span>Side A ${escapeHtml(a)} · Side B ${escapeHtml(b)} · margin ${escapeHtml(Math.abs(a - b))}</span>
      </div>
    `;
  }).join('') : '';
  const verdict = challenge.verdict ? `
    <section class="surface judge-panel verdict" data-testid="verdict-panel">
      <div class="status">final verdict</div>
      <h2>Winner: Side ${escapeHtml(challenge.verdict.winner)}</h2>
      <p>${escapeHtml(challenge.verdict.summary)}</p>
      <div class="score-card">
        <div><span>Side A</span><strong>${escapeHtml(challenge.verdict.payout?.scores1000?.A ?? '-')}</strong></div>
        <div><span>Side B</span><strong>${escapeHtml(challenge.verdict.payout?.scores1000?.B ?? '-')}</strong></div>
        <div><span>Margin</span><strong>${escapeHtml(challenge.verdict.payout?.margin ?? '-')}</strong></div>
      </div>
      <div class="tiny">confidence ${escapeHtml(challenge.verdict.confidence)} · votes ${escapeHtml(JSON.stringify(challenge.verdict.votes))}</div>
      <div class="judge-results">${judgeResults}</div>
    </section>
  ` : '';
  const accept = challenge.canAccept ? `
    <button class="primary" data-action="accept" data-testid="accept-challenge">Accept and lock ${escapeHtml(challenge.stakeDisplay)} ${escapeHtml(challenge.tokenSymbol)}</button>
  ` : '';
  const submit = challenge.canSubmit ? `
    <section class="turn-box">
      <div class="status">court filing · your turn as side ${escapeHtml(challenge.userSide)}</div>
      <form data-action="submit-message">
        <textarea data-testid="message-body" name="body" placeholder="File your argument for Side ${escapeHtml(challenge.userSide)}. Address the prior filing directly, cite context, and ask the judge board for a score out of 1000."></textarea>
        <button class="primary" data-testid="submit-message">Submit turn</button>
      </form>
    </section>
  ` : `<div class="turn-box tiny">Waiting for Side ${escapeHtml(challenge.expectedSide || '-')} counsel to file the next argument.</div>`;
  const judgeButton = challenge.status === 'ready_for_judging' ? `
    <button class="primary" data-action="judge" data-testid="run-judges">Run judge board</button>
  ` : '';
  const withdraw = challenge.verdict && challenge.userSide === challenge.verdict.winner ? `
    <section class="surface wallet-panel">
      <div class="status">winner payout</div>
      <h2>Withdraw winnings to XLN wallet</h2>
      <form data-action="withdraw">
        <div class="grid-2">
          <label>Amount
            <input data-testid="withdraw-amount" name="amount" value="${escapeHtml(challenge.stakeDisplay === '0' ? '0' : String(Number(challenge.stakeDisplay) * 2 || '20'))}" />
          </label>
          <label>Token
            <select name="tokenId"><option value="${challenge.tokenId}">${escapeHtml(challenge.tokenSymbol)}</option></select>
          </label>
        </div>
        <label>Target XLN entity
          <input data-testid="target-entity" name="targetEntityId" value="0x1111111111111111111111111111111111111111111111111111111111111111" />
        </label>
        <button class="primary" data-testid="withdraw">Withdraw</button>
      </form>
    </section>
  ` : '';

  return shell(`
    <section class="surface hero">
      <div class="hero-top">
        <div class="hero-meta">
          <span class="status" data-testid="challenge-status">${escapeHtml(challenge.status)}</span>
          <span class="pill">${escapeHtml(challenge.visibility)}</span>
          <span class="pill">${challenge.judgeBoard.length} judges</span>
        </div>
        <span class="pill">${escapeHtml(challenge.tokenSymbol)} escrow</span>
      </div>
      <h2 class="statement">${escapeHtml(challenge.statement)}</h2>
      <div class="market-strip">
        <div class="market-cell"><span>Stake</span><strong>${escapeHtml(challenge.stakeDisplay)} ${escapeHtml(challenge.tokenSymbol)}</strong></div>
        <div class="market-cell"><span>Rounds</span><strong>${challenge.messages.length}/${challenge.roundsTotal * 2}</strong></div>
        <div class="market-cell"><span>Current Turn</span><strong>Side ${escapeHtml(challenge.expectedSide || '-')}</strong></div>
        <div class="market-cell"><span>Payout</span><strong>${challenge.verdict ? `Side ${escapeHtml(challenge.verdict.winner)} +${escapeHtml(challenge.verdict.payout?.margin ?? 0)}` : 'Winner takes all'}</strong></div>
      </div>
      <div class="sides">
        <div class="side-box a"><div class="side-label">Side A · affirmative</div><strong>${escapeHtml(challenge.sideALabel)}</strong></div>
        <div class="versus">VS</div>
        <div class="side-box b"><div class="side-label">Side B · counterparty</div><strong>${escapeHtml(challenge.sideBLabel)}</strong></div>
      </div>
      ${invite ? `
        <div class="invite-dock">
          <div class="section-title"><h3>Invite link</h3><span class="tiny">share with counterparty</span></div>
          <div class="copy-line">
            <input data-testid="invite-link" readonly value="${escapeHtml(invite)}" />
            <button data-action="copy-invite">Copy</button>
          </div>
        </div>
      ` : ''}
      <div style="margin-top:14px">${accept}${judgeButton}</div>
      <div class="error">${escapeHtml(errorText)}</div>
    </section>
    <section class="surface judge-panel" style="margin-top:14px">
      <div class="section-title">
        <h3>Judge Board</h3>
        <span class="pill">1000-point scoring</span>
      </div>
      <div class="judge-grid">${judges}</div>
    </section>
    ${verdict}
    <section class="surface transcript">
      <div class="section-title">
        <h3>Transcript</h3>
        <span class="pill">${challenge.messages.length}/${challenge.roundsTotal * 2}</span>
      </div>
      ${messages || '<div class="empty">No arguments submitted yet.</div>'}
      ${challenge.status === 'active' ? submit : ''}
    </section>
    ${withdraw}
  `);
}

function render() {
  app.innerHTML = currentChallenge ? challengeView(currentChallenge) : homeView();
}

async function refreshChallenge() {
  const slug = routeSlug();
  if (!slug) {
    await load();
    return;
  }
  const detail = await api(`/api/challenges/${encodeURIComponent(slug)}`);
  currentChallenge = detail.challenge;
  const me = await api('/api/me');
  dashboard = me;
  render();
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  try {
    errorText = '';
    if (action === 'dev-fund') {
      await api('/api/dev/fund', { method: 'POST', body: { tokenId: 1, amount: '250' } });
      await load();
    }
    if (action === 'deposit-instructions') {
      const result = await api('/api/deposit/instructions?tokenId=1');
      depositInfo = result;
      render();
    }
    if (action === 'seed-demo') {
      target.textContent = 'Loading cases...';
      await api('/api/dev/seed-demo', { method: 'POST', body: {} });
      await load();
    }
    if (action === 'accept') {
      await api(`/api/challenges/${encodeURIComponent(currentChallenge.slug)}/accept`, { method: 'POST', body: {} });
      await refreshChallenge();
    }
    if (action === 'judge') {
      target.textContent = 'Judging...';
      await api(`/api/challenges/${encodeURIComponent(currentChallenge.slug)}/judge`, { method: 'POST', body: {} });
      await refreshChallenge();
    }
    if (action === 'copy-invite') {
      const input = document.querySelector('[data-testid="invite-link"]');
      input?.select();
      await navigator.clipboard.writeText(input?.value || '');
    }
  } catch (error) {
    errorText = error.message || String(error);
    render();
  }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  const action = form.dataset.action;
  if (!action) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    errorText = '';
    if (action === 'create-challenge') {
      const created = await api('/api/challenges', { method: 'POST', body: data });
      history.pushState({}, '', `/c/${created.challenge.slug}`);
      currentChallenge = created.challenge;
      const me = await api('/api/me');
      dashboard = me;
      render();
    }
    if (action === 'submit-message') {
      await api(`/api/challenges/${encodeURIComponent(currentChallenge.slug)}/messages`, { method: 'POST', body: data });
      await refreshChallenge();
    }
    if (action === 'withdraw') {
      const result = await api('/api/withdraw', { method: 'POST', body: data });
      await load();
      alert(`Withdrawal ${result.withdrawal.status}: ${result.withdrawal.hashlock}`);
    }
  } catch (error) {
    errorText = error.message || String(error);
    render();
  }
});

window.addEventListener('popstate', load);

load().catch(error => {
  app.innerHTML = `<div class="boot">Failed to load XLN Debates: ${escapeHtml(error.message || error)}</div>`;
});
