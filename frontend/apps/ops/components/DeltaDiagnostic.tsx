import { useState } from 'react';
import type { Delta } from '@xln/runtime/types/account';
import { deriveOpsDelta, parseOpsDelta, type OpsDerivedDelta } from '../data/ops-delta-adapter';

const defaults: Record<keyof Delta, string> = { tokenId: '1', collateral: '1000', ondelta: '0', offdelta: '0', leftCreditLimit: '500', rightCreditLimit: '500', leftAllowance: '0', rightAllowance: '0', leftHold: '0', rightHold: '0' };
export const DeltaDiagnostic = () => {
  const [values, setValues] = useState(defaults); const [left, setLeft] = useState(true); const [result, setResult] = useState<OpsDerivedDelta | null>(null); const [error, setError] = useState<string | null>(null);
  const run = (): void => { try { setResult(deriveOpsDelta(parseOpsDelta(values), left)); setError(null); } catch (cause) { setResult(null); setError(cause instanceof Error ? cause.message : String(cause)); } };
  return <details className="ops-panel ops-delta"><summary>Canonical delta diagnostic</summary><p>Calls Runtime <code>deriveDelta</code>; this surface contains no financial formula.</p><div className="ops-form-grid">{Object.entries(values).map(([key, value]) => <label key={key}>{key}<input inputMode="numeric" value={value} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))}/></label>)}</div><label><input type="checkbox" checked={left} onChange={event => setLeft(event.target.checked)}/> left perspective</label><button type="button" onClick={run}>Derive canonical view</button>{error ? <div className="ops-error" role="alert">{error}</div> : result ? <pre data-testid="ops-delta-result">{result.ascii}{`\ninCapacity=${result.inCapacity}\noutCapacity=${result.outCapacity}\noutTotalHold=${result.outTotalHold}`}</pre> : null}</details>;
};
