/**
 * Presentation annotation over an account's bars: the numbers the bars encode, in words a
 * central banker reads at a glance ("collateral 500K USDC", "Hub owes Bob 250K USDC,
 * unsecured"). Amounts come from the canonical delta derivation, never from bar geometry.
 */

import * as THREE from 'three';
import type { Delta } from '@xln/core/api/public/runtime-module';

type DeltaView = {
  collateral: bigint;
  /** Left's share of the collateral. */
  outCollateral: bigint;
  /** Right's share of the collateral. */
  inCollateral: bigint;
  /** What right owes left beyond collateral (left perspective). */
  outPeerCredit: bigint;
  /** What left owes right beyond collateral (left perspective). */
  inOwnCredit: bigint;
};

export type AccountAnnotationContext = {
  labelFor(entityId: string): string;
  /** Stage-formatted amount, e.g. "250K". */
  formatAmount(tokenId: number, amount: bigint): string;
  symbolOf(tokenId: number): string;
  derive(delta: Delta, isLeft: boolean): DeltaView;
  /** World height of one annotation line. */
  lineHeight: number;
};

export type AnnotationLine = { text: string; tone: 'collateral' | 'unsecured' };

/** A share below this fraction of the collateral (routing-fee dust) is not worth a label. */
const SHARE_NOTE_BPS = 50n;

/**
 * What the account holds, per token: its collateral (and who it belongs to), then any
 * unsecured debt. Symbols are named only when an account carries several currencies.
 */
export function accountAnnotationLines(
  leftId: string,
  rightId: string,
  deltas: ReadonlyMap<number, Delta>,
  context: AccountAnnotationContext,
): AnnotationLine[] {
  const perToken = [...deltas.keys()].sort((a, b) => a - b)
    .map((tokenId) => ({ tokenId, facts: tokenFacts(leftId, rightId, deltas.get(tokenId)!, context) }))
    .filter((entry) => entry.facts.length > 0);
  // Symbols are named only when the account shows positions in more than one currency.
  const showSymbol = perToken.length > 1;
  return perToken.flatMap(({ tokenId, facts }) => facts.map((fact) => ({
    tone: fact.tone,
    text: fact.parts.map((part) => (typeof part === 'string' ? part : `${context.formatAmount(tokenId, part)}${showSymbol ? ` ${context.symbolOf(tokenId)}` : ''}`)).join(''),
  })));
}

type Fact = { tone: AnnotationLine['tone']; parts: Array<string | bigint> };

/** Collateral (and who it belongs to), then any unsecured debt, for one token. */
function tokenFacts(leftId: string, rightId: string, delta: Delta, context: AccountAnnotationContext): Fact[] {
  const left = context.labelFor(leftId);
  const right = context.labelFor(rightId);
  const view = context.derive(delta, true);
  const facts: Fact[] = [];
  if (view.collateral > 0n) {
    const [major, minor] = view.outCollateral >= view.inCollateral
      ? [{ who: left, share: view.outCollateral }, { who: right, share: view.inCollateral }]
      : [{ who: right, share: view.inCollateral }, { who: left, share: view.outCollateral }];
    const split = minor.share * 10_000n >= view.collateral * SHARE_NOTE_BPS;
    facts.push({ tone: 'collateral', parts: split ? ['collateral ', view.collateral, ` · ${minor.who}'s share `, minor.share] : ['collateral ', view.collateral, ` (${major.who}'s)`] });
  }
  if (view.outPeerCredit > 0n) facts.push({ tone: 'unsecured', parts: [`${right} owes ${left} `, view.outPeerCredit, ', unsecured'] });
  if (view.inOwnCredit > 0n) facts.push({ tone: 'unsecured', parts: [`${left} owes ${right} `, view.inOwnCredit, ', unsecured'] });
  return facts;
}

const TONE_COLOR: Record<AnnotationLine['tone'], string> = { collateral: '#5ee69a', unsecured: '#c9b8ff' };
const FONT_PX = 44;
const LINE_PX = 58;
const PAD_PX = 18;

/** A camera-facing card with one line per fact, centred on `position`. */
export function createAccountAnnotation(lines: readonly AnnotationLine[], position: THREE.Vector3, lineHeight: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('ACCOUNT_ANNOTATION_CONTEXT_UNAVAILABLE');
  context.font = `600 ${FONT_PX}px Inter, 'Helvetica Neue', Arial, sans-serif`;
  const width = Math.ceil(Math.max(...lines.map((line) => context.measureText(line.text).width))) + PAD_PX * 2;
  canvas.width = width;
  canvas.height = lines.length * LINE_PX + PAD_PX;
  context.fillStyle = 'rgba(6, 12, 22, 0.78)';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, canvas.height, 16);
  context.fill();
  context.font = `600 ${FONT_PX}px Inter, 'Helvetica Neue', Arial, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  lines.forEach((line, index) => {
    context.fillStyle = TONE_COLOR[line.tone];
    context.fillText(line.text, canvas.width / 2, PAD_PX / 2 + LINE_PX * (index + 0.5));
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  const worldHeight = lineHeight * (canvas.height / LINE_PX);
  sprite.scale.set(worldHeight * (canvas.width / canvas.height), worldHeight, 1);
  sprite.position.copy(position);
  sprite.renderOrder = 5;
  sprite.name = 'xln-account-annotation';
  sprite.userData['lines'] = lines.map((line) => line.text);
  return sprite;
}
