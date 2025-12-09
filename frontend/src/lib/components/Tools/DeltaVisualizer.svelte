<script lang="ts">
  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  // Local deriveDelta implementation (matches runtime/account-utils.ts exactly)
  function deriveDelta(delta: any, isLeftPerspective: boolean) {
    const nonNegative = (x: bigint): bigint => x < 0n ? 0n : x;

    const totalDelta = delta.ondelta + delta.offdelta;
    const collateral = nonNegative(delta.collateral);

    let ownCreditLimit = delta.leftCreditLimit;
    let peerCreditLimit = delta.rightCreditLimit;

    let inCollateral = totalDelta > 0n ? nonNegative(collateral - totalDelta) : collateral;
    let outCollateral = totalDelta > 0n ? (totalDelta > collateral ? collateral : totalDelta) : 0n;

    let inOwnCredit = nonNegative(0n - totalDelta);
    if (inOwnCredit > ownCreditLimit) inOwnCredit = ownCreditLimit;

    let outPeerCredit = nonNegative(totalDelta - collateral);
    if (outPeerCredit > peerCreditLimit) outPeerCredit = peerCreditLimit;

    let outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);
    let inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit);

    let inAllowence: bigint = delta.rightAllowance ?? 0n;
    let outAllowence: bigint = delta.leftAllowance ?? 0n;

    const totalCapacity = collateral + ownCreditLimit + peerCreditLimit;

    let inCapacity = nonNegative((outCollateral + inOwnCredit + outPeerCredit) - inAllowence);
    let outCapacity = nonNegative((inCollateral + outOwnCredit + inPeerCredit) - outAllowence);

    if (!isLeftPerspective) {
      [inCollateral, inAllowence, inCapacity, outCollateral, outAllowence, outCapacity] =
      [outCollateral, outAllowence, outCapacity, inCollateral, inAllowence, inCapacity];

      [ownCreditLimit, peerCreditLimit] = [peerCreditLimit, ownCreditLimit];
      [outOwnCredit, inOwnCredit, outPeerCredit, inPeerCredit] =
      [inPeerCredit, outPeerCredit, inOwnCredit, outOwnCredit];
    }

    const totalWidth = Number(totalCapacity) || 1;
    const leftCreditWidth = Math.floor((Number(delta.leftCreditLimit) / totalWidth) * 50);
    const collateralWidth = Math.floor((Number(collateral) / totalWidth) * 50);
    const rightCreditWidth = 50 - leftCreditWidth - collateralWidth;
    const deltaPosition = Math.floor(((Number(totalDelta) + Number(delta.leftCreditLimit)) / totalWidth) * 50);

    const fullBar = '-'.repeat(Math.max(0, leftCreditWidth)) +
                    '='.repeat(Math.max(0, collateralWidth)) +
                    '-'.repeat(Math.max(0, rightCreditWidth));
    const clampedPosition = Math.max(0, Math.min(deltaPosition, fullBar.length));
    const ascii = '[' + fullBar.substring(0, clampedPosition) + '|' + fullBar.substring(clampedPosition) + ']';

    return {
      delta: totalDelta,
      collateral,
      inCollateral,
      outCollateral,
      inOwnCredit,
      outPeerCredit,
      inAllowence,
      outAllowence,
      totalCapacity,
      ownCreditLimit,
      peerCreditLimit,
      inCapacity,
      outCapacity,
      outOwnCredit,
      inPeerCredit,
      ascii,
    };
  }

  // Input state with sensible defaults (scaled to 18 decimals)
  let collateral = $state(500000n * 10n**18n);
  let ondelta = $state(0n);
  let offdelta = $state(-125000n * 10n**18n);
  let leftCreditLimit = $state(0n);
  let rightCreditLimit = $state(500000n * 10n**18n);
  let leftAllowance = $state(0n);
  let rightAllowance = $state(0n);
  let perspective = $state<'left' | 'right'>('left');

  // Build delta object
  let deltaInput = $derived({
    tokenId: 1,
    collateral,
    ondelta,
    offdelta,
    leftCreditLimit,
    rightCreditLimit,
    leftAllowance,
    rightAllowance,
  });

  // Calculate derived values
  let derivedOutput = $derived(deriveDelta(deltaInput, perspective === 'left'));

  // Calculate bar segments for visualization
  let barSegments = $derived.by(() => {
    const total = Number(derivedOutput.totalCapacity) || 1;
    const leftCredit = (Number(deltaInput.leftCreditLimit) / total) * 100;
    const coll = (Number(derivedOutput.collateral) / total) * 100;
    const rightCredit = (Number(deltaInput.rightCreditLimit) / total) * 100;

    const totalDelta = Number(derivedOutput.delta);
    const leftLimit = Number(deltaInput.leftCreditLimit);
    const position = ((totalDelta + leftLimit) / total) * 100;

    return {
      leftCredit: Math.max(0, leftCredit),
      collateral: Math.max(0, coll),
      rightCredit: Math.max(0, rightCredit),
      position: Math.max(0, Math.min(100, position)),
    };
  });

  function formatBigInt(val: bigint): string {
    return (Number(val) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function parseBigInt(str: string): bigint {
    const num = parseFloat(str.replace(/,/g, '')) || 0;
    return BigInt(Math.round(num * 1e18));
  }
</script>

<div class="modal-backdrop" onclick={onClose}>
  <div class="modal" onclick={(e) => e.stopPropagation()}>
    <div class="modal-header">
      <h2>deriveDelta Visualizer</h2>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>

    <div class="modal-body">
      <!-- Perspective Toggle -->
      <div class="perspective-toggle">
        <span class="label">Perspective:</span>
        <button class:active={perspective === 'left'} onclick={() => perspective = 'left'}>
          LEFT
        </button>
        <button class:active={perspective === 'right'} onclick={() => perspective = 'right'}>
          RIGHT
        </button>
      </div>

      <!-- Visual Bar -->
      <div class="bar-container">
        <div class="bar-labels">
          <span>LEFT Credit</span>
          <span>Collateral</span>
          <span>RIGHT Credit</span>
        </div>
        <div class="capacity-bar">
          <div class="segment left-credit" style="width: {barSegments.leftCredit}%"></div>
          <div class="segment collateral" style="width: {barSegments.collateral}%"></div>
          <div class="segment right-credit" style="width: {barSegments.rightCredit}%"></div>
          <div class="position-marker" style="left: {barSegments.position}%"></div>
        </div>
        <div class="bar-info">
          <span class="pos-label">Delta Position: {barSegments.position.toFixed(1)}%</span>
        </div>
      </div>

      <!-- Input Grid -->
      <div class="input-grid">
        <div class="input-section">
          <h3>Raw Delta (Canonical)</h3>
          <label>
            <span>collateral</span>
            <input type="text" value={formatBigInt(collateral)} oninput={(e) => collateral = parseBigInt(e.currentTarget.value)} />
          </label>
          <label>
            <span>ondelta</span>
            <input type="text" value={formatBigInt(ondelta)} oninput={(e) => ondelta = parseBigInt(e.currentTarget.value)} />
          </label>
          <label>
            <span>offdelta</span>
            <input type="text" value={formatBigInt(offdelta)} oninput={(e) => offdelta = parseBigInt(e.currentTarget.value)} />
          </label>
          <label>
            <span>leftCreditLimit</span>
            <input type="text" value={formatBigInt(leftCreditLimit)} oninput={(e) => leftCreditLimit = parseBigInt(e.currentTarget.value)} />
          </label>
          <label>
            <span>rightCreditLimit</span>
            <input type="text" value={formatBigInt(rightCreditLimit)} oninput={(e) => rightCreditLimit = parseBigInt(e.currentTarget.value)} />
          </label>
        </div>

        <div class="output-section">
          <h3>Derived ({perspective.toUpperCase()} view)</h3>
          <div class="output-row">
            <span class="key">totalDelta</span>
            <span class="val" class:negative={derivedOutput.delta < 0n}>{formatBigInt(derivedOutput.delta)}</span>
          </div>
          <div class="output-row">
            <span class="key">outCapacity</span>
            <span class="val highlight-out">{formatBigInt(derivedOutput.outCapacity)}</span>
          </div>
          <div class="output-row">
            <span class="key">inCapacity</span>
            <span class="val highlight-in">{formatBigInt(derivedOutput.inCapacity)}</span>
          </div>
          <div class="output-row">
            <span class="key">inCollateral</span>
            <span class="val">{formatBigInt(derivedOutput.inCollateral)}</span>
          </div>
          <div class="output-row">
            <span class="key">outCollateral</span>
            <span class="val">{formatBigInt(derivedOutput.outCollateral)}</span>
          </div>
          <div class="output-row">
            <span class="key">ownCreditLimit</span>
            <span class="val">{formatBigInt(derivedOutput.ownCreditLimit)}</span>
          </div>
          <div class="output-row">
            <span class="key">peerCreditLimit</span>
            <span class="val">{formatBigInt(derivedOutput.peerCreditLimit)}</span>
          </div>
          <div class="output-row">
            <span class="key">inOwnCredit</span>
            <span class="val">{formatBigInt(derivedOutput.inOwnCredit)}</span>
          </div>
          <div class="output-row">
            <span class="key">outOwnCredit</span>
            <span class="val">{formatBigInt(derivedOutput.outOwnCredit)}</span>
          </div>
          <div class="output-row">
            <span class="key">inPeerCredit</span>
            <span class="val">{formatBigInt(derivedOutput.inPeerCredit)}</span>
          </div>
          <div class="output-row">
            <span class="key">outPeerCredit</span>
            <span class="val">{formatBigInt(derivedOutput.outPeerCredit)}</span>
          </div>
          <div class="ascii-bar">
            <code>{derivedOutput.ascii}</code>
          </div>
        </div>
      </div>

      <!-- Explanation -->
      <div class="explanation">
        <h4>Semantics</h4>
        <ul>
          <li><b>leftCreditLimit</b>: Credit LEFT extends to RIGHT (RIGHT can owe LEFT)</li>
          <li><b>rightCreditLimit</b>: Credit RIGHT extends to LEFT (LEFT can owe RIGHT)</li>
          <li><b>totalDelta &gt; 0</b>: LEFT has given more → RIGHT owes LEFT</li>
          <li><b>totalDelta &lt; 0</b>: LEFT owes RIGHT (using rightCreditLimit)</li>
          <li><b>outCapacity</b>: How much {perspective.toUpperCase()} can SEND</li>
          <li><b>inCapacity</b>: How much {perspective.toUpperCase()} can RECEIVE</li>
        </ul>
      </div>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: #0a0a0f;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    width: 90%;
    max-width: 900px;
    max-height: 90vh;
    overflow: auto;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: #fff;
  }

  .close-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .close-btn:hover { color: #fff; }

  .modal-body { padding: 1.5rem; }

  .perspective-toggle {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .perspective-toggle .label {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.875rem;
  }

  .perspective-toggle button {
    padding: 0.5rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    transition: all 0.15s;
  }

  .perspective-toggle button:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .perspective-toggle button.active {
    background: rgba(79, 209, 139, 0.2);
    border-color: rgba(79, 209, 139, 0.5);
    color: #4fd18b;
  }

  .bar-container {
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
  }

  .bar-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.5);
    margin-bottom: 0.5rem;
  }

  .capacity-bar {
    position: relative;
    height: 32px;
    display: flex;
    border-radius: 4px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.05);
  }

  .segment { height: 100%; transition: width 0.2s; }
  .segment.left-credit { background: linear-gradient(90deg, #ff6b6b, #ff8787); }
  .segment.collateral { background: linear-gradient(90deg, #4fd18b, #69db9f); }
  .segment.right-credit { background: linear-gradient(90deg, #4dabf7, #74c0fc); }

  .position-marker {
    position: absolute;
    top: -4px;
    bottom: -4px;
    width: 3px;
    background: #fff;
    border-radius: 2px;
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
    transform: translateX(-50%);
    transition: left 0.2s;
  }

  .bar-info {
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.6);
    text-align: center;
  }

  .input-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }

  .input-section h3, .output-section h3 {
    margin: 0 0 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.8);
  }

  .input-section label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .input-section label span {
    width: 120px;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.6);
    font-family: 'SF Mono', monospace;
  }

  .input-section input {
    flex: 1;
    padding: 0.4rem 0.6rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: #fff;
    font-family: 'SF Mono', monospace;
    font-size: 0.8rem;
  }

  .input-section input:focus {
    outline: none;
    border-color: rgba(79, 209, 139, 0.5);
  }

  .output-row {
    display: flex;
    justify-content: space-between;
    padding: 0.3rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .output-row .key {
    font-family: 'SF Mono', monospace;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
  }

  .output-row .val {
    font-family: 'SF Mono', monospace;
    font-size: 0.8rem;
    color: #fff;
  }

  .output-row .val.negative { color: #ff6b6b; }
  .output-row .val.highlight-out { color: #4dabf7; font-weight: 600; }
  .output-row .val.highlight-in { color: #4fd18b; font-weight: 600; }

  .ascii-bar {
    margin-top: 1rem;
    padding: 0.5rem;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 4px;
  }

  .ascii-bar code {
    font-family: 'SF Mono', monospace;
    font-size: 0.9rem;
    color: #4fd18b;
  }

  .explanation {
    margin-top: 1.5rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
    border-left: 3px solid rgba(79, 209, 139, 0.5);
  }

  .explanation h4 {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    color: rgba(255, 255, 255, 0.8);
  }

  .explanation ul {
    margin: 0;
    padding-left: 1.25rem;
  }

  .explanation li {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.6);
    margin-bottom: 0.25rem;
  }

  .explanation b { color: rgba(255, 255, 255, 0.8); }

  @media (max-width: 768px) {
    .input-grid { grid-template-columns: 1fr; }
  }
</style>
