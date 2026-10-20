import { useState } from 'react';
import { Icon } from './Icons';
import { tokenGlyph } from '../runtime/format';
import { getTokenMeta, knownTokenIds, type TokenCatalogEntry } from '../runtime/token-meta';

export function TokenIcon({
  tokenId,
  size = 'md',
  catalog,
}: {
  tokenId: number;
  size?: 'md' | 'sm';
  catalog?: readonly TokenCatalogEntry[] | undefined;
}) {
  const meta = getTokenMeta(tokenId, catalog);
  return (
    <span className={`token-icon${size === 'sm' ? ' sm' : ''}`} style={{ background: meta.color }} aria-hidden>
      {tokenGlyph(meta.symbol)}
    </span>
  );
}

export function TokenPicker({
  tokenId,
  onChange,
  exclude,
  chip,
  catalog,
}: {
  tokenId: number;
  onChange: (tokenId: number) => void;
  exclude?: number;
  chip?: string;
  catalog?: readonly TokenCatalogEntry[];
}) {
  const [open, setOpen] = useState(false);
  const meta = getTokenMeta(tokenId, catalog);
  const tokenIds = knownTokenIds(catalog);
  return (
    <div className="picker">
      <button
        type="button"
        className="pill"
        onClick={() => setOpen(value => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={tokenIds.length === 0}
      >
        <TokenIcon tokenId={tokenId} size="sm" catalog={catalog} />
        {meta.symbol}
        {chip ? <span className="chip">{chip}</span> : null}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="picker-menu right" role="listbox" style={{ minWidth: 220 }}>
          {tokenIds
            .filter(id => id !== exclude)
            .map(id => {
              const option = getTokenMeta(id, catalog);
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={id === tokenId}
                  className={`picker-option${id === tokenId ? ' active' : ''}`}
                  onClick={() => {
                    onChange(id);
                    setOpen(false);
                  }}
                >
                  <span className="t">
                    <TokenIcon tokenId={id} size="sm" catalog={catalog} />
                    {option.symbol}
                  </span>
                  <span className="faint" style={{ fontSize: 11.5 }}>
                    {option.name}
                  </span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
