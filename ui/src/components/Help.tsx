import { walletHelp } from '@xln/frontend/lib/utils/ui/walletHelp';

export function Help({ topic, label = 'How this works' }: { topic: string; label?: string }) {
  return <details className="disclosure" style={{ margin: '8px 0' }}>
    <summary>{label}</summary>
    <p className="note">{walletHelp[topic]}</p>
  </details>;
}
