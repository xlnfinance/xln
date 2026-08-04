import { useState } from 'react';
import { qaAdminRequest, type QaRunDetail } from '../data/ops-qa';

type Props = Readonly<{ run: QaRunDetail | null; restartAllowed: boolean; restartActive: boolean; onChanged(): Promise<void> }>;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error || 'OPS_QA_ADMIN_FAILED');

export const QaAdminControls = ({ run, restartAllowed, restartActive, onChanged }: Props) => {
  const [selectedShard, setSelectedShard] = useState(0);
  const [operatorId, setOperatorId] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [expectedGitHead, setExpectedGitHead] = useState('');
  const [command, setCommand] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);
  const shard = run?.shards[selectedShard] ?? null;
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null); setResult('');
    try { await action(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const plan = (): void => void perform(async () => {
    if (!run || !shard) throw new Error('OPS_QA_RESTART_SELECTION_REQUIRED');
    const payload = await qaAdminRequest('/api/qa/restart?mode=plan', { runId: run.runId, shard: shard.shard });
    if (!Array.isArray(payload['command']) || payload['command'].some(part => typeof part !== 'string')) throw new Error('OPS_QA_RESTART_PLAN_INVALID');
    if (payload['expectedGitHead'] !== null && typeof payload['expectedGitHead'] !== 'string') throw new Error('OPS_QA_RESTART_HEAD_INVALID');
    setCommand(Object.freeze([...payload['command']] as string[])); setExpectedGitHead(payload['expectedGitHead'] ?? ''); setResult('Plan verified by server. Review the exact command.');
  });
  const restart = (): void => void perform(async () => {
    if (!run || !shard || command.length === 0) throw new Error('OPS_QA_RESTART_PLAN_REQUIRED');
    await qaAdminRequest('/api/qa/restart?mode=run', { runId: run.runId, shard: shard.shard, operatorId: operatorId.trim(), reason: reason.trim(), confirm: confirm.trim(), expectedGitHead: expectedGitHead.trim() });
    setCommand([]); setConfirm(''); setResult('Restart accepted by server.'); await onChanged();
  });
  const maintenance = (url: string, body: Readonly<Record<string, unknown>>, success: string): void => void perform(async () => {
    await qaAdminRequest(url, body); setConfirm(''); setResult(success); await onChanged();
  });
  return (
    <section className="ops-panel ops-admin" data-testid="qa-admin-controls">
      <header><div><span>admin authority</span><strong>{restartAllowed ? 'available' : 'read only'}</strong></div><i className={restartActive ? 'is-degraded' : 'is-healthy'}>{restartActive ? 'restart active' : 'idle'}</i></header>
      {!restartAllowed ? <p>Server capability does not allow restart or retention actions.</p> : <>
        <div className="ops-form-row"><label>Shard<select value={selectedShard} onChange={event => { setSelectedShard(Number(event.target.value)); setCommand([]); }}>{run?.shards.map((item, index) => <option key={item.shard} value={index}>{item.shard} · {item.target}</option>)}</select></label><button type="button" disabled={busy || !shard || restartActive} onClick={plan}>Plan exact restart</button></div>
        {command.length ? <pre data-testid="qa-restart-command">{command.join(' ')}</pre> : null}
        <div className="ops-form-grid"><label>Operator ID<input value={operatorId} onChange={event => setOperatorId(event.target.value)} /></label><label>Reason<input value={reason} onChange={event => setReason(event.target.value)} /></label><label>Expected HEAD<input value={expectedGitHead} onChange={event => setExpectedGitHead(event.target.value)} /></label><label>Confirmation<input value={confirm} onChange={event => setConfirm(event.target.value)} placeholder="server-required phrase" /></label></div>
        <div className="ops-actions"><button type="button" disabled={busy || command.length === 0 || !operatorId.trim() || !reason.trim() || !confirm.trim()} onClick={restart}>Run planned restart</button><button type="button" disabled={busy || !confirm.trim()} onClick={() => maintenance('/api/qa/retention', { confirm: confirm.trim() }, 'Retention purge completed.')}>Purge retention</button><button type="button" disabled={busy || !confirm.trim()} onClick={() => maintenance('/api/qa/history/backfill', { confirm: confirm.trim(), limit: 500 }, 'History backfill completed.')}>Backfill history</button><button type="button" disabled={busy || !restartActive || !confirm.trim()} onClick={() => maintenance('/api/qa/restart/abort', { confirm: confirm.trim() }, 'Restart abort accepted.')}>Abort restart</button></div>
      </>}
      {error ? <div className="ops-error" role="alert">{error}</div> : null}{result ? <p className="ops-notice" role="status">{result}</p> : null}
    </section>
  );
};
