#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync } from 'fs';
import { basename, relative, resolve } from 'path';
import { inflateSync } from 'zlib';

type Status = 'pass' | 'warn' | 'fail';

type PngImage = {
  width: number;
  height: number;
  rgba: Uint8Array;
};

type VisualMetrics = {
  file: string;
  width: number;
  height: number;
  lumaMean: number;
  lumaStdDev: number;
  lumaP05: number;
  lumaP95: number;
  contrastRange: number;
  edgeDensity: number;
  accentRatio: number;
  blueRatio: number;
  greenRatio: number;
  yellowRatio: number;
  redRatio: number;
  brightRatio: number;
  emptyDarkRatio: number;
  borderSignal: number;
};

type Category = {
  name: string;
  status: Status;
  detail: string;
};

type VisualCheckResult = {
  profile: string;
  files: VisualMetrics[];
  screens: Array<{
    file: string;
    score: number;
    verdict: Status;
    categories: Category[];
  }>;
  categories: Category[];
  score: number;
  verdict: Status;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function usage(): never {
  console.error('Usage: bun tools/visualcheck.ts [--json] [--profile=app|swap] <screenshot.png|dir> [...]');
  process.exit(1);
}

function parseArgs(argv: string[]): { json: boolean; profile: string; files: string[] } {
  let json = false;
  let profile = 'generic';
  const files: string[] = [];
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length) || 'generic';
    else if (arg.startsWith('-')) usage();
    else files.push(arg);
  }
  if (files.length === 0) usage();
  return { json, profile, files };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function parsePng(file: string): PngImage {
  const data = readFileSync(file);
  if (data.length < 32 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${file}: not a PNG file`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(chunk));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width <= 0 || height <= 0) throw new Error(`${file}: missing IHDR dimensions`);
  if (bitDepth !== 8) throw new Error(`${file}: unsupported PNG bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new Error(`${file}: unsupported PNG color type ${colorType}`);

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (inflated.length < expected) throw new Error(`${file}: truncated image data`);

  const raw = new Uint8Array(width * height * channels);
  let inOffset = 0;
  let outOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inOffset]!;
    inOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[inOffset + x]!;
      const left = x >= channels ? raw[outOffset + x - channels]! : 0;
      const up = y > 0 ? raw[outOffset + x - stride]! : 0;
      const upLeft = y > 0 && x >= channels ? raw[outOffset + x - stride - channels]! : 0;
      if (filter === 0) raw[outOffset + x] = value;
      else if (filter === 1) raw[outOffset + x] = (value + left) & 0xff;
      else if (filter === 2) raw[outOffset + x] = (value + up) & 0xff;
      else if (filter === 3) raw[outOffset + x] = (value + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) raw[outOffset + x] = (value + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`${file}: unsupported PNG filter ${filter}`);
    }
    inOffset += stride;
    outOffset += stride;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
    if (channels === 1) {
      const gray = raw[i]!;
      rgba[j] = gray;
      rgba[j + 1] = gray;
      rgba[j + 2] = gray;
      rgba[j + 3] = 255;
    } else {
      rgba[j] = raw[i]!;
      rgba[j + 1] = raw[i + 1]!;
      rgba[j + 2] = raw[i + 2]!;
      rgba[j + 3] = channels === 4 ? raw[i + 3]! : 255;
    }
  }

  return { width, height, rgba };
}

function percentile(histogram: number[], total: number, pct: number): number {
  const target = Math.max(0, Math.min(total - 1, Math.floor(total * pct)));
  let seen = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    seen += histogram[i]!;
    if (seen > target) return i;
  }
  return histogram.length - 1;
}

function analyzeImage(file: string): VisualMetrics {
  const image = parsePng(file);
  const { width, height, rgba } = image;
  const histogram = new Array<number>(256).fill(0);
  const sampleStep = Math.max(1, Math.floor(Math.sqrt((width * height) / 260_000)));
  let count = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  let accent = 0;
  let blue = 0;
  let green = 0;
  let yellow = 0;
  let red = 0;
  let bright = 0;
  let dark = 0;
  let border = 0;
  let borderCount = 0;
  let edges = 0;
  let edgeSamples = 0;

  const lumaAt = (x: number, y: number): number => {
    const index = (y * width + x) * 4;
    return 0.2126 * rgba[index]! + 0.7152 * rgba[index + 1]! + 0.0722 * rgba[index + 2]!;
  };

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const index = (y * width + x) * 4;
      const r = rgba[index]!;
      const g = rgba[index + 1]!;
      const b = rgba[index + 2]!;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      histogram[luma] += 1;
      count += 1;
      lumaSum += luma;
      lumaSqSum += luma * luma;
      if (luma > 130) bright += 1;
      if (luma < 24) dark += 1;
      if (sat > 35 && luma > 35) accent += 1;
      if (b > r + 25 && b > g + 10 && luma > 45) blue += 1;
      if (g > r + 20 && g > b + 10 && luma > 45) green += 1;
      if (r > 120 && g > 80 && b < 80) yellow += 1;
      if (r > g + 25 && r > b + 25 && luma > 45) red += 1;
      if (x < 4 || y < 4 || x >= width - 4 || y >= height - 4) {
        borderCount += 1;
        if (luma > 50 || sat > 30) border += 1;
      }
      if (x + sampleStep < width && y + sampleStep < height) {
        const dx = Math.abs(luma - lumaAt(x + sampleStep, y));
        const dy = Math.abs(luma - lumaAt(x, y + sampleStep));
        if (dx + dy > 32) edges += 1;
        edgeSamples += 1;
      }
    }
  }

  const mean = lumaSum / Math.max(1, count);
  const variance = lumaSqSum / Math.max(1, count) - mean * mean;
  const p05 = percentile(histogram, count, 0.01);
  const p95 = percentile(histogram, count, 0.995);
  return {
    file: relative(process.cwd(), file),
    width,
    height,
    lumaMean: mean,
    lumaStdDev: Math.sqrt(Math.max(0, variance)),
    lumaP05: p05,
    lumaP95: p95,
    contrastRange: p95 - p05,
    edgeDensity: edges / Math.max(1, edgeSamples),
    accentRatio: accent / Math.max(1, count),
    blueRatio: blue / Math.max(1, count),
    greenRatio: green / Math.max(1, count),
    yellowRatio: yellow / Math.max(1, count),
    redRatio: red / Math.max(1, count),
    brightRatio: bright / Math.max(1, count),
    emptyDarkRatio: dark / Math.max(1, count),
    borderSignal: border / Math.max(1, borderCount),
  };
}

function aggregate(files: VisualMetrics[]) {
  const avg = (field: keyof VisualMetrics): number =>
    files.reduce((sum, file) => sum + Number(file[field]), 0) / Math.max(1, files.length);
  const min = (field: keyof VisualMetrics): number =>
    Math.min(...files.map((file) => Number(file[field])));
  const max = (field: keyof VisualMetrics): number =>
    Math.max(...files.map((file) => Number(file[field])));
  return { avg, min, max };
}

function statusFrom(ok: boolean, warn: boolean): Status {
  if (!ok) return 'fail';
  if (warn) return 'warn';
  return 'pass';
}

function category(name: string, status: Status, detail: string): Category {
  return { name, status, detail };
}

function buildCategories(profile: string, files: VisualMetrics[]): Category[] {
  const agg = aggregate(files);
  const names = files.map((file) => basename(file.file).toLowerCase());
  const menuScreens = names.filter((name) => name.includes('menu')).length;
  const hasSwapProfile = profile === 'swap';
  const minWidth = hasSwapProfile ? 1100 : profile === 'app' ? 360 : 320;
  const minHeight = hasSwapProfile ? 700 : profile === 'app' ? 600 : 360;

  const categories = [
    category(
      'integrity',
      statusFrom(files.every((file) => file.width >= minWidth && file.height >= minHeight), false),
      `screens=${files.length}, min=${Math.round(agg.min('width'))}x${Math.round(agg.min('height'))}`,
    ),
    category(
      'contrast',
      statusFrom(agg.min('contrastRange') >= 95 && agg.min('lumaStdDev') >= 15, agg.min('contrastRange') < 110),
      `min range=${agg.min('contrastRange').toFixed(1)}, min std=${agg.min('lumaStdDev').toFixed(1)}`,
    ),
    category(
      'scan-density',
      statusFrom(
        agg.min('edgeDensity') >= 0.035 && agg.max('edgeDensity') <= 0.34,
        agg.min('edgeDensity') < 0.038 || agg.max('edgeDensity') > 0.30,
      ),
      `edge avg=${agg.avg('edgeDensity').toFixed(3)}, range=${agg.min('edgeDensity').toFixed(3)}-${agg.max('edgeDensity').toFixed(3)}`,
    ),
    category(
      'visual-hierarchy',
      statusFrom(
        agg.min('accentRatio') >= (profile === 'app' ? 0.006 : 0.015)
          && agg.max('accentRatio') <= 0.20
          && agg.min('brightRatio') >= 0.006,
        agg.min('accentRatio') < (profile === 'app' ? 0.01 : 0.025) || agg.max('accentRatio') > 0.16,
      ),
      `accent avg=${agg.avg('accentRatio').toFixed(3)}, bright avg=${agg.avg('brightRatio').toFixed(3)}`,
    ),
  ];

  if (hasSwapProfile) {
    categories.push(
      category(
        'route-token-signals',
        statusFrom(
          agg.max('blueRatio') >= 0.0015
            && agg.max('greenRatio') >= 0.002
            && agg.max('yellowRatio') >= 0.002
            && agg.max('redRatio') >= 0.002,
          false,
        ),
        `blue=${agg.max('blueRatio').toFixed(3)}, green=${agg.max('greenRatio').toFixed(3)}, yellow=${agg.max('yellowRatio').toFixed(3)}, red=${agg.max('redRatio').toFixed(3)}`,
      ),
    );
  }

  categories.push(
    category(
      'framing',
      statusFrom(agg.max('borderSignal') <= 0.18, agg.max('borderSignal') > 0.12),
      `edge contact max=${agg.max('borderSignal').toFixed(3)}`,
    ),
    category(
      'state-coverage',
      hasSwapProfile
        ? statusFrom(
            names.some((name) => name.includes('base'))
              && names.some((name) => name.includes('source'))
              && names.some((name) => name.includes('token'))
              && names.some((name) => name.includes('route'))
              && names.some((name) => name.includes('hub'))
              && menuScreens >= 4,
            false,
          )
        : 'pass',
      hasSwapProfile ? `base/source/token/route/hub screens, menu screens=${menuScreens}` : 'generic profile',
    ),
  );
  return categories;
}

function scoreCategories(categories: Category[]): { score: number; verdict: Status } {
  const failCount = categories.filter((entry) => entry.status === 'fail').length;
  const warnCount = categories.filter((entry) => entry.status === 'warn').length;
  return {
    score: Math.max(0, 100 - failCount * 20 - warnCount * 5),
    verdict: failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass',
  };
}

function collectPngFiles(targets: string[]): string[] {
  const out: string[] = [];
  const walk = (target: string) => {
    const abs = resolve(target);
    if (!existsSync(abs)) return;
    const stat = lstatSync(abs);
    if (stat.isFile()) {
      if (abs.toLowerCase().endsWith('.png')) out.push(abs);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(resolve(abs, entry.name));
    }
  };
  for (const target of targets) walk(target);
  return Array.from(new Set(out)).sort();
}

function buildResult(profile: string, files: string[]): VisualCheckResult {
  const pngFiles = collectPngFiles(files);
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) throw new Error(`Missing screenshot(s): ${missing.join(', ')}`);
  if (pngFiles.length === 0) throw new Error('No PNG screenshots found.');
  const metrics = pngFiles.map((file) => analyzeImage(resolve(file)));
  const screenProfile = profile === 'swap' ? 'app' : profile;
  const screens = metrics.map((file) => {
    const categories = buildCategories(screenProfile, [file]);
    const scored = scoreCategories(categories);
    return { file: file.file, ...scored, categories };
  });
  const categories = buildCategories(profile, metrics);
  const scored = scoreCategories(categories);
  return { profile, files: metrics, screens, categories, score: scored.score, verdict: scored.verdict };
}

function renderText(result: VisualCheckResult): string {
  const lines: string[] = [];
  lines.push(`Profile: ${result.profile}`);
  lines.push(`Screenshots: ${result.files.length}`);
  lines.push('');
  lines.push('Files');
  for (const file of result.files) {
    lines.push(
      `- ${file.file}: ${file.width}x${file.height}, contrast=${file.contrastRange.toFixed(1)}, edge=${file.edgeDensity.toFixed(3)}, accent=${file.accentRatio.toFixed(3)}`,
    );
  }
  lines.push('');
  lines.push('Screen scores');
  for (const screen of result.screens) {
    lines.push(`- ${screen.score}/100 ${screen.verdict.toUpperCase()} ${screen.file}`);
  }
  lines.push('');
  lines.push('UX heuristics');
  for (const entry of result.categories) {
    lines.push(`- ${entry.name}: ${entry.status} (${entry.detail})`);
  }
  lines.push('');
  lines.push(`Score: ${result.score}/100`);
  lines.push(`Verdict: ${result.verdict.toUpperCase()}`);
  return lines.join('\n');
}

const { json, profile, files } = parseArgs(process.argv.slice(2));
try {
  const result = buildResult(profile, files);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
  process.exit(result.verdict === 'fail' ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
