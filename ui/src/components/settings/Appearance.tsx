import { useNavigate } from 'react-router-dom';
import { Bar } from '../Bars';
import { Icon } from '../Icons';
import { useApp } from '../../runtime/store';
import { ACCENTS, MATERIALS, NUMBER_FONTS, RISK_COLORS } from '../../runtime/design';

export function Appearance() {
  const navigate = useNavigate();
  const theme = useApp(s => s.theme);
  const density = useApp(s => s.density);
  const setDensity = useApp(s => s.setDensity);
  const design = useApp(s => s.design);
  const setDesign = useApp(s => s.setDesign);
  const setTheme = useApp(s => s.setTheme);
  const tour = useApp(s => s.tour);
  const setTour = useApp(s => s.setTour);
  return (
    <>
      <div className="sect">
        <h3 className="caps">Appearance</h3>
      </div>
      <div className="setting first">
        <div>
          <div className="t">Layout on wide screens</div>
          <div className="s">
            Desk is the dense console: every account and lane in one table, the book beside it, ⌘K to jump.
          </div>
        </div>
        <span className="segc">
          <button
            type="button"
            className={density === 'comfort' ? 'active' : ''}
            onClick={() => setDensity('comfort')}
            data-testid="density-comfort"
          >
            Comfort
          </button>
          <button
            type="button"
            className={density === 'desk' ? 'active' : ''}
            onClick={() => setDensity('desk')}
            data-testid="density-desk"
          >
            Desk
          </button>
        </span>
      </div>
      <div className="setting">
        <div className="t">Theme</div>
        <span className="segc">
          <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
            <Icon name="moon" size={13} /> Dark
          </button>
          <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
            <Icon name="sun" size={13} /> Light
          </button>
        </span>
      </div>

      <div className="sect">
        <h3 className="caps">Design</h3>
        <span className="faint">presets · yours to change</span>
      </div>
      <div className="card design-sample" data-testid="design-sample">
        <div className="hero-label">Sample</div>
        <div className="display num" style={{ fontSize: 34 }}>
          $1,284,500<span className="dec">.00</span>
        </div>
        <div className="rb">
          <Bar
            segments={[
              { usd: 400_000, kind: 'onchain' },
              { usd: 300_000, kind: 'reserve' },
              { usd: 250_000, kind: 'coll' },
              { usd: 200_000, kind: 'risk' },
              { usd: 134_500, kind: 'debt' },
            ]}
            height={8}
          />
        </div>
        {/* Presentation, not controls: this card shows what the chosen design
				    looks like, so these must not read as buttons a person can press. */}
        <div className="actions" style={{ marginTop: 10 }} aria-hidden>
          <span className="btn primary sm">Pay</span>
          <span className="btn sm">Receive</span>
        </div>
      </div>
      <div className="setting first">
        <div>
          <div className="t">Material</div>
          <div className="s">{MATERIALS.find(entry => entry.id === design.material)?.hint}</div>
        </div>
        <span className="segc">
          {MATERIALS.map(entry => (
            <button
              key={entry.id}
              type="button"
              className={design.material === entry.id ? 'active' : ''}
              onClick={() => setDesign({ material: entry.id })}
              data-testid={`design-material-${entry.id}`}
            >
              {entry.title}
            </button>
          ))}
        </span>
      </div>
      <div className="setting">
        <div>
          <div className="t">Accent</div>
          <div className="s">{ACCENTS.find(entry => entry.id === design.accent)?.hint}</div>
        </div>
        <span className="segc">
          {ACCENTS.map(entry => (
            <button
              key={entry.id}
              type="button"
              className={design.accent === entry.id ? 'active' : ''}
              onClick={() => setDesign({ accent: entry.id })}
              data-testid={`design-accent-${entry.id}`}
              title={entry.title}
            >
              {entry.swatch ? <i className="sw" style={{ background: entry.swatch }} /> : null}
              {entry.title}
            </button>
          ))}
        </span>
      </div>
      {design.accent === 'custom' ? (
        <div className="setting">
          <div className="t">Custom accent</div>
          <span className="field-row" style={{ gap: 8 }}>
            <input
              type="color"
              value={design.accentHex}
              onChange={event => setDesign({ accentHex: event.target.value })}
              aria-label="Accent color"
              data-testid="design-accent-hex"
            />
            <span className="mono muted">{design.accentHex}</span>
          </span>
        </div>
      ) : null}
      <div className="setting">
        <div>
          <div className="t">Numbers</div>
          <div className="s">{NUMBER_FONTS.find(entry => entry.id === design.numbers)?.hint}</div>
        </div>
        <span className="segc">
          {NUMBER_FONTS.map(entry => (
            <button
              key={entry.id}
              type="button"
              className={design.numbers === entry.id ? 'active' : ''}
              onClick={() => setDesign({ numbers: entry.id })}
              data-testid={`design-numbers-${entry.id}`}
            >
              {entry.title}
            </button>
          ))}
        </span>
      </div>
      <div className="setting">
        <div>
          <div className="t">Risk color</div>
          <div className="s">{RISK_COLORS.find(entry => entry.id === design.risk)?.hint}</div>
        </div>
        <span className="segc">
          {RISK_COLORS.map(entry => (
            <button
              key={entry.id}
              type="button"
              className={design.risk === entry.id ? 'active' : ''}
              onClick={() => setDesign({ risk: entry.id })}
              data-testid={`design-risk-${entry.id}`}
            >
              <i className="sw" style={{ background: entry.swatch }} />
              {entry.title}
            </button>
          ))}
        </span>
      </div>

      <div className="sect">
        <h3 className="caps">Tour</h3>
      </div>
      <div className="setting first">
        <div>
          <div className="t">Guided tour</div>
          <div className="s">
            {tour.completed
              ? 'Completed on this device, across wallets. Replay any time.'
              : tour.index > 0
                ? `Paused at step ${tour.index + 1}.`
                : 'Credit, payment, collateral, swap, dispute: five minutes on a live sandbox.'}
          </div>
        </div>
        <span className="segc">
          {tour.index > 0 && !tour.completed ? (
            <button type="button" onClick={() => setTour({ active: true })} data-testid="tour-resume">
              Resume
            </button>
          ) : null}
          <button type="button" onClick={() => { setTour({ active: true, index: 0, completed: false }); navigate('/'); }} data-testid="tour-replay">
            {tour.completed || tour.index > 0 ? 'Replay' : 'Start'}
          </button>
        </span>
      </div>
    </>
  );
}
