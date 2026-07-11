import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MetricDelta, ReleaseManifest, ReleaseSnapshot, TreeNode } from './types.ts';
import { renderFrozenTree } from '../frozen-core/core.ts';

const SNAPSHOT_START = '<!-- release-snapshot:start -->';
const SNAPSHOT_END = '<!-- release-snapshot:end -->';

function number(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function signed(value: number): string {
  if (!value) return '0';
  return `${value > 0 ? '+' : ''}${number(value)}`;
}

function deltaText(delta: MetricDelta | null, key: 'code' | 'complexity'): string {
  return delta ? ` (${signed(delta[key])})` : '';
}

function categoryMarker(node: TreeNode): string {
  if (node.kind === 'directory') return '[D]';
  if (node.category === 'test') return '[T]';
  return '[F]';
}

function nodeLine(node: TreeNode, prefix: string): string {
  const label = `${categoryMarker(node)} ${node.name}${node.kind === 'directory' ? '/' : ''}`;
  const gap = ' '.repeat(Math.max(1, 62 - prefix.length - label.length));
  return `${prefix}${label}${gap}LOC ${number(node.metrics.code)}${deltaText(node.delta, 'code')}  C ${number(node.metrics.complexity)}${deltaText(node.delta, 'complexity')}`;
}

function renderChildren(node: TreeNode, prefix: string, lines: string[]): void {
  const children = node.children ?? [];
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    lines.push(nodeLine(child, `${prefix}${last ? '`-- ' : '|-- '}`));
    if (child.kind === 'directory') renderChildren(child, `${prefix}${last ? '    ' : '|   '}`, lines);
  });
}

export function renderAscii(snapshot: ReleaseSnapshot): string {
  const metrics = snapshot.repository.metrics;
  const lines = [
    `xln / RELEASE ${snapshot.release.version} / CODEBASE SNAPSHOT`,
    `tag ${snapshot.release.tag} | commit ${snapshot.release.sourceCommit.slice(0, 12)} | ${snapshot.release.generatedAt}`,
    `LOC ${number(metrics.code)}${deltaText(snapshot.repository.delta, 'code')} | complexity ${number(metrics.complexity)}${deltaText(snapshot.repository.delta, 'complexity')} | files ${number(metrics.files)} | tests ${number(metrics.testCode)} LOC`,
    '',
    nodeLine(snapshot.tree, ''),
  ];
  renderChildren(snapshot.tree, '', lines);
  return lines.join('\n');
}

function snapshotBlock(snapshot: ReleaseSnapshot): string {
  const metrics = snapshot.repository.metrics;
  const changes = snapshot.repository.changes;
  return [
    SNAPSHOT_START,
    '```text',
    renderAscii(snapshot),
    '```',
    '',
    `Snapshot: ${number(metrics.files)} files, ${number(metrics.code)} code LOC, ${number(metrics.complexity)} complexity, test/source ratio ${(metrics.testCodeRatio * 100).toFixed(1)}%.`,
    `Change set: ${number(changes.added)} added, ${number(changes.modified)} modified, ${number(changes.removed)} removed.`,
    ...(snapshot.frozenCore ? [
      '',
      '```text',
      renderFrozenTree(snapshot.frozenCore),
      '```',
      '',
      `Frozen core: ${snapshot.frozenCore.status}. Root ${snapshot.frozenCore.rootHash}.`,
    ] : []),
    ...(snapshot.attestation ? [
      '',
      `Foundation Hanko: VERIFIED ${snapshot.attestation.signerCount}/${snapshot.attestation.board.members.length}, entity ${snapshot.attestation.board.entityId}.`,
    ] : []),
    SNAPSHOT_END,
  ].join('\n');
}

export function writeReleaseMarkdown(path: string, snapshot: ReleaseSnapshot): void {
  const block = snapshotBlock(snapshot);
  if (!existsSync(path)) {
    writeFileSync(path, `${block}\n\n# xln ${snapshot.release.version}\n\n## Release Notes\n\nRelease notes pending.\n`);
    return;
  }
  const current = readFileSync(path, 'utf8');
  const start = current.indexOf(SNAPSHOT_START);
  const end = current.indexOf(SNAPSHOT_END);
  if (start < 0 || end < start) {
    writeFileSync(path, `${block}\n\n${current.trimStart()}`);
    return;
  }
  writeFileSync(path, `${current.slice(0, start)}${block}${current.slice(end + SNAPSHOT_END.length)}`);
}

export function writeManifest(releasesDir: string): ReleaseManifest {
  const dataDir = join(releasesDir, 'data');
  const releases = readdirSync(dataDir)
    .filter((name) => /^\d+\.\d+\.\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(dataDir, name), 'utf8')) as ReleaseSnapshot)
    .sort((left, right) => right.release.version.localeCompare(left.release.version, undefined, { numeric: true }))
    .map((snapshot) => ({
      version: snapshot.release.version,
      tag: snapshot.release.tag,
      generatedAt: snapshot.release.generatedAt,
      markdown: `/docs-catalog/releases/${snapshot.release.version}.md`,
      snapshot: `/docs-catalog/releases/data/${snapshot.release.version}.json`,
      sourceCommit: snapshot.release.sourceCommit,
      metrics: snapshot.repository.metrics,
      modules: Object.fromEntries((snapshot.tree.children ?? [])
        .filter((node) => node.kind === 'directory')
        .map((node) => [node.path, node.metrics])),
      codeSnapshotRoot: snapshot.repository.merkleRoot,
      ...(snapshot.frozenCore ? { frozenCore: snapshot.frozenCore } : {}),
      ...(snapshot.attestation ? { attestation: snapshot.attestation } : {}),
    }));
  if (!releases[0]) throw new Error(`No release snapshots found in ${dataDir}`);
  const manifest: ReleaseManifest = { schemaVersion: 1, latest: releases[0].version, releases };
  writeFileSync(join(releasesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
