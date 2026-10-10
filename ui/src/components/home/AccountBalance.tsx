import { Bar } from '../Bars';
import { usdOf } from '../../runtime/financial/prices';
import type { AccountTokenView } from '../../runtime/views';

/** Balance backing and payment limits are different quantities; both use canonical deriveDelta fields. */
export function AccountBalance({
  token,
  disputed,
  closed,
  symbol,
  money,
}: {
  token: AccountTokenView;
  disputed: boolean;
  closed: boolean;
  symbol: string;
  money: (amount: bigint) => string;
}) {
  const d = token.derived;
  return (
    <div className="account-funding">
      <Bar
        segments={[
          { usd: usdOf(token.tokenId, d.outCollateral), kind: 'coll' },
          { usd: usdOf(token.tokenId, d.outPeerCredit), kind: 'risk' },
        ]}
      />
      <div className="account-backing">
        <span>
          <i className="sw c-coll" />
          Backed by collateral{' '}
          <b className="num">
            {money(d.outCollateral)} {symbol}
          </b>
        </span>
        <span>
          <i className="sw c-risk" />
          Without collateral{' '}
          <b className="num">
            {money(d.outPeerCredit)} {symbol}
          </b>
        </span>
        {d.inOwnCredit > 0n && (
          <span>
            <i className="sw c-debt" />
            You owe{' '}
            <b className="num">
              {money(d.inOwnCredit)} {symbol}
            </b>
          </span>
        )}
      </div>
      {disputed ? <p className="note">{closed ? 'Account permanently closed after dispute. Connect another account to resume payments.' : 'Account frozen by dispute. Payments are unavailable.'}</p> : null}
      <div className="account-limits">
        <span>
          Can send now
          <strong className="num">
            {money(disputed ? 0n : d.outCapacity)} {symbol}
          </strong>
        </span>
        <span>
          Can receive now
          <strong className="num">
            {money(disputed ? 0n : d.inCapacity)} {symbol}
          </strong>
        </span>
      </div>
      {(d.outTotalHold > 0n || d.inTotalHold > 0n) && (
        <p className="note">
          In progress: {money(d.outTotalHold)} {symbol} outgoing · {money(d.inTotalHold)} {symbol} incoming. Limits
          above exclude these amounts.
        </p>
      )}
      <span className="account-link">View account and adjust limits →</span>
    </div>
  );
}
