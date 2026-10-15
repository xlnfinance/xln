import { useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { formatMoney, parseAmount, shortId } from '../../runtime/format';
import { getTokenMeta } from '../../runtime/token-meta';
import type { AccountView } from '../../runtime/views';

const DETERMINISTIC_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const DEFAULT_SALT = '0x0000000000000000000000000000000000000000000000000000000000000001';

type ClauseTemplate = Readonly<{
	id: string;
	title: string;
	summary: string;
	schema: string;
	initcodeHash: string;
	defaultParamsHex: string;
}>;

const TEMPLATES: readonly ClauseTemplate[] = [
	{
		id: 'piecewise-payoff',
		title: 'PiecewisePayoff · Perp / Option / Stop-Loss',
		summary: 'Clamped linear payoff Δ = clamp(slope · (P_oracle − P_entry), −rightCap, +leftCap) signed by any Entity oracle Hanko.',
		schema: 'bytes32 oracleEntity, uint64 expiry, int256 entryPrice, int256 slopeBps',
		initcodeHash: '0x8b4c97e401d26e18f7e9f31d0a9e1a6a9155d6e1d36d19f27a116a9f0c010001',
		defaultParamsHex: '0x00000000000000000000000000000000000000000000000000000000000003e8',
	},
	{
		id: 'call-option',
		title: 'CallOption · Covered Exercise Clause',
		summary: 'Holder exercises up to baseAmount at strikeTotal before expiry by revealing preimage or on-chain secret.',
		schema: 'bool writerIsLeft, uint8 baseIdx, uint8 quoteIdx, uint256 baseAmount, uint256 strikeTotal, uint64 expiry',
		initcodeHash: '0x9c1e52a1b40811e02f9d4c3e8a71b6f50983c1d2e4f6a8b0c2d4e6f800020002',
		defaultParamsHex: '0x00000000000000000000000000000000000000000000000000000000b2d05e00',
	},
	{
		id: 'concentrated-curve',
		title: 'ConcentratedCurve · Range AMM Quote',
		summary: 'Continuous x·y=k liquidity between [sqrtPriceLower, sqrtPriceUpper] settled by uint16 fillRatio.',
		schema: 'uint8 addDeltaIndex, uint8 subDeltaIndex, uint128 liquidityL, uint128 sqrtLower, uint128 sqrtUpper',
		initcodeHash: '0x7d3a19f0c2e4b6a890123456789abcdef0123456789abcdef012345600030003',
		defaultParamsHex: '0x0000000000000000000000000000000000000000000000000000000000002710',
	},
];

function computeCreate2Address(saltHex: string, initcodeHashHex: string): string {
	try {
		const salt = /^0x[0-9a-fA-F]{64}$/.test(saltHex) ? saltHex : DEFAULT_SALT;
		const hash = /^0x[0-9a-fA-F]{64}$/.test(initcodeHashHex) ? initcodeHashHex : TEMPLATES[0]!.initcodeHash;
		return ethers.getCreate2Address(DETERMINISTIC_DEPLOYER, salt, hash).toLowerCase();
	} catch {
		return '0x0000000000000000000000000000000000000000';
	}
}

export function ClausesPanel({ account }: { account: AccountView }) {
	const [templateId, setTemplateId] = useState<string>(TEMPLATES[0]!.id);
	const [salt, setSalt] = useState(DEFAULT_SALT);
	const [paramsHex, setParamsHex] = useState(TEMPLATES[0]!.defaultParamsHex);
	const [leftCapText, setLeftCapText] = useState('100');
	const [rightCapText, setRightCapText] = useState('100');
	const template = TEMPLATES.find(item => item.id === templateId) ?? TEMPLATES[0]!;
	const token = account.tokens[0];
	const meta = getTokenMeta(token?.tokenId ?? 1);

	const create2Address = useMemo(
		() => computeCreate2Address(salt.trim(), template.initcodeHash),
		[salt, template.initcodeHash],
	);

	const leftAllowance = useMemo(() => {
		try {
			return leftCapText.trim() ? parseAmount(leftCapText, meta.decimals) : 0n;
		} catch {
			return 0n;
		}
	}, [leftCapText, meta.decimals]);

	const rightAllowance = useMemo(() => {
		try {
			return rightCapText.trim() ? parseAmount(rightCapText, meta.decimals) : 0n;
		} catch {
			return 0n;
		}
	}, [rightCapText, meta.decimals]);

	const committedClauses = useMemo(() => {
		const map = account.doc?.state?.subcontracts;
		if (!map) return [];
		return Array.from(map.entries()).map(([id, value]) => ({ id, value }));
	}, [account.doc]);

	return (
		<div className="fade-in" data-testid="clauses-panel">
			<p className="note">
				Counterfactual Delta Transformers (`IDeltaTransformer`) execute off-chain at zero gas and deploy via{' '}
				<code>CREATE2</code> only if an uncooperative dispute finalizes. Every outcome is strictly bounded by the signed{' '}
				<code>Allowance</code> caps on `Account.sol`.
			</p>

			{committedClauses.length > 0 ? (
				<div className="card tight" style={{ marginBottom: 12 }} data-testid="clauses-active">
					<h4 className="caps">Active subcontracts ({committedClauses.length})</h4>
					{committedClauses.map(({ id, value }) => (
						<div key={id} className="kv">
							<span className="k mono">{shortId(id, 10, 6)}</span>
							<span className="v mono">
								{'kind' in value ? `${value.kind} · ${formatMoney(value.principal, meta.decimals)} ${meta.symbol}` : shortId(value.transformerAddress, 8, 6)}
							</span>
						</div>
					))}
				</div>
			) : null}

			<div className="field">
				<span className="field-label">Extension template</span>
				<div className="mode-grid">
					{TEMPLATES.map(item => (
						<button
							key={item.id}
							type="button"
							className={`mode-card${template.id === item.id ? ' active' : ''}`}
							onClick={() => {
								setTemplateId(item.id);
								setParamsHex(item.defaultParamsHex);
							}}
							data-testid={`clause-template-${item.id}`}
						>
							<span className="t">{item.title}</span>
							<span className="s">{item.summary}</span>
						</button>
					))}
				</div>
			</div>

			<div className="field">
				<span className="field-label">ABI schema · encodedBatch</span>
				<p className="note mono" style={{ marginBottom: 6 }}>
					{template.schema}
				</p>
				<input
					className="input mono"
					value={paramsHex}
					onChange={event => setParamsHex(event.target.value)}
					spellCheck={false}
					data-testid="clause-params-hex"
				/>
			</div>

			<div className="field">
				<span className="field-label">Signed Allowance caps ({meta.symbol}) · Max bilateral loss</span>
				<div className="field-row">
					<input
						className="input"
						placeholder="Left allowance cap"
						inputMode="decimal"
						value={leftCapText}
						onChange={event => setLeftCapText(event.target.value)}
						data-testid="clause-left-cap"
					/>
					<input
						className="input"
						placeholder="Right allowance cap"
						inputMode="decimal"
						value={rightCapText}
						onChange={event => setRightCapText(event.target.value)}
						data-testid="clause-right-cap"
					/>
				</div>
			</div>

			<div className="field">
				<span className="field-label">CREATE2 salt (32-byte hex)</span>
				<input
					className="input mono"
					value={salt}
					onChange={event => setSalt(event.target.value)}
					spellCheck={false}
					data-testid="clause-salt"
				/>
			</div>

			<div className="card tight" style={{ marginBottom: 12 }} data-testid="clause-preview">
				<div className="kv">
					<span className="k">Counterfactual CREATE2 address</span>
					<span className="v mono" data-testid="clause-create2-address">
						{shortId(create2Address, 10, 8)}
					</span>
				</div>
				<div className="kv">
					<span className="k">Clamped max shift (Left / Right)</span>
					<span className="v num">
						+{formatMoney(leftAllowance, meta.decimals)} / −{formatMoney(rightAllowance, meta.decimals)} {meta.symbol}
					</span>
				</div>
				<div className="kv">
					<span className="k">Happy-path on-chain gas</span>
					<span className="v num st-settled">0 gas (off-chain settlement)</span>
				</div>
			</div>
		</div>
	);
}
