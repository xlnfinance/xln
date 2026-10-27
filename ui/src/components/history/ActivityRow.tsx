import { Icon, type IconName } from '../Icons';
import { formatAmount } from '../../runtime/format';
import { getTokenMeta } from '../../runtime/token-meta';
import { displayEntityName } from '../../runtime/views';
import type { Movement } from '../../runtime/financial/movements';
export const TONE_CLASS: Record<Movement['tone'], string> = {
  settled: 'st-settled',
  inflight: 'st-inflight',
  pending: 'st-pending',
  failed: 'st-dispute',
  neutral: 'st-neutral',
};

function movementIcon(movement: Movement): { icon: IconName; cls: string } {
  if (movement.kind === 'swap') return { icon: 'swap', cls: 'swap' };
  if (movement.kind === 'onchain') return { icon: 'bank', cls: 'reserve' };
  if (movement.kind === 'settlement') return { icon: 'bank', cls: 'reserve' };
  if (movement.kind === 'account') return { icon: 'shield', cls: 'account' };
  if (movement.direction === 'in') return { icon: 'receive', cls: 'in' };
  return { icon: 'pay', cls: 'out' };
}

export function formatMovementAmount(movement: Movement): string | null {
  if (movement.amount === null || movement.tokenId === null) return null;
  const meta = getTokenMeta(movement.tokenId);
  const sign =
    movement.kind === 'payment' && movement.tone !== 'failed' && movement.tone !== 'inflight'
      ? movement.direction === 'out'
        ? '−'
        : movement.direction === 'in'
          ? '+'
          : ''
      : '';
  const primary = `${sign}${formatAmount(movement.amount, meta.decimals, meta.decimals)} ${meta.symbol}`;
  if (movement.kind !== 'swap' || movement.quoteAmount == null || movement.quoteTokenId == null) return primary;
  const quote = getTokenMeta(movement.quoteTokenId);
  return `${primary} → ${formatAmount(movement.quoteAmount, quote.decimals, quote.decimals)} ${quote.symbol}`;
}

/** "to Meridian Desk via Hub One" / "from Hub One" / "with Hub One". */
export function movementParty(movement: Movement, names: Map<string, string>): string {
  if (!movement.counterpartyId) return '';
  const name = displayEntityName(names, movement.counterpartyId);
  if (movement.kind !== 'payment') return name;
  if (movement.direction === 'in') return `From ${name}`;
  return `${movement.hopOnly ? 'Through' : 'To'} ${name}`;
}

/** "14:05" today, "Oct 1, 14:05" before; the frame stays in the detail view for whoever needs the proof. */
function movementTime(movement: Movement): string {
  if (!movement.timestamp) return `frame #${movement.height}`;
  const at = new Date(movement.timestamp);
  const time = at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

export function ActivityRow({
  movement,
  names,
  first,
  selected,
  onClick,
}: {
  movement: Movement;
  names: Map<string, string>;
  first: boolean;
  selected?: boolean;
  onClick?: () => void;
}) {
  const amount = formatMovementAmount(movement);
  const { icon, cls } = movementIcon(movement);
  const party = movementParty(movement, names);
  // A credit limit or collateral figure is a setting, not money that moved: keep it out of the money column.
  const amountInline = movement.kind === 'account' || movement.kind === 'settlement';
  const time = movementTime(movement);
  const detail = [party, amountInline && amount ? amount : ''].filter(Boolean).join(' · ');
  const Tag = onClick ? 'button' : 'span';
  return (
    <div
      className={`row${onClick ? ' tappable' : ''}${selected ? ' sel' : ''}${first ? ' first' : ''}`}
      data-testid="activity-row"
    >
      <Tag
        {...(onClick ? { type: 'button' as const, onClick } : {})}
        className="rt"
        style={{ width: '100%', textAlign: 'left' }}
      >
        <span className={`ev-ic ${cls}`}>
          <Icon name={icon} size={15} />
        </span>
        <span className="t">
          {movement.kind === 'payment' && movement.tone === 'failed'
            ? 'Payment failed'
            : movement.kind === 'payment' && movement.tone === 'inflight'
              ? 'Payment pending'
              : movement.title}
        </span>
        <span className="ap">{detail || <span className="ap-time">{time}</span>}</span>
        <span className="aa num">{amount && !amountInline ? amount : ''}</span>
        <span className="as">
          <span className={`state ${TONE_CLASS[movement.tone]}`}>{movement.state}</span>
        </span>
        <span className="ad num">{time}</span>
      </Tag>
    </div>
  );
}

/** Column captions for a table of ActivityRow; hidden where rows fold to two lines. */
export function ActivityHead() {
  return (
    <div className="dtable-head" aria-hidden>
      <span className="ht">Description</span>
      <span className="hp">Counterparty</span>
      <span className="ha">Amount</span>
      <span className="hs">Status</span>
      <span className="hd">Date</span>
    </div>
  );
}
