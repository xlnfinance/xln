#!/usr/bin/env bun
/**
 * Send the wallet screenshots to vision models through the pi CLI and collect
 * their rubric scores.
 *
 *   bun ui/tools/design-shots.ts                       # 1. take the shots
 *   bun ui/tools/design-review.ts [--tier cheap|smart] [--models a,b] [--variants x,y]
 *                                                      # 2. ask the reviewers
 *   → design/review/<date>/<model>.<variant>.json + summary.md
 *
 * `--resummarize` rebuilds summary.md from the JSON already in the run dir.
 * Default reviewers (all accept images, all cheap): GLM-4.6V on the zai plan,
 * Gemini Flash and Grok on OpenRouter. pi is `-p --mode json`; the model's
 * final message is parsed as JSON per design/review/rubric.md.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const SHOTS_ROOT = join(REPO_ROOT, 'design/screenshots/ui');
const RUBRIC = join(REPO_ROOT, 'design/review/rubric.md');
/**
 * Two juries. `cheap` (default) runs after every iteration: four vision models
 * from four vendors, pennies per pass. `smart` runs once at the end of a polish
 * round. Pick with --tier or override with --models.
 */
const TIERS: Record<string, string[]> = {
	cheap: ['zai-coding-cn/glm-5.3-flash', 'openrouter/google/gemini-flash-latest', 'openrouter/mistralai/mistral-small-2603', 'openrouter/minimax/minimax-m3:free'],
	smart: ['openrouter/moonshotai/kimi-k3', 'openrouter/google/gemini-pro-latest', 'openrouter/x-ai/grok-latest', 'openrouter/anthropic/claude-sonnet-5'],
};
const DEFAULT_MODELS = TIERS[process.argv[process.argv.indexOf('--tier') + 1] ?? ''] ?? TIERS['cheap']!;
const PARAMETERS = ['hierarchy', 'premium', 'typography', 'color', 'data_legibility', 'layout', 'visceral_value', 'responsive', 'consistency', 'trust'] as const;
const REVIEW_TIMEOUT_MS = 15 * 60_000;

type ScreenReview = {
	file: string;
	scores: Record<string, number>;
	total: number;
	top_issues: string[];
	fixes: string[];
};
type Review = {
	reviewer: string;
	screens: ScreenReview[];
	overall: { total: number; verdict: string; priority_fixes: string[] };
};

const argValue = (flag: string): string | undefined => {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
};

const models = (argValue('--models') || DEFAULT_MODELS.join(',')).split(',').map(m => m.trim()).filter(Boolean);
const variantFilter = new Set((argValue('--variants') || '').split(',').map(v => v.trim()).filter(Boolean));
const runDir = join(REPO_ROOT, 'design/review', argValue('--run') || new Date().toISOString().slice(0, 10));

async function listVariants(): Promise<Array<{ name: string; files: string[] }>> {
	const entries = await readdir(SHOTS_ROOT, { withFileTypes: true });
	const variants: Array<{ name: string; files: string[] }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (variantFilter.size > 0 && !variantFilter.has(entry.name)) continue;
		const files = (await readdir(join(SHOTS_ROOT, entry.name))).filter(f => f.endsWith('.png')).sort();
		if (files.length > 0) variants.push({ name: entry.name, files: files.map(f => join(SHOTS_ROOT, entry.name, f)) });
	}
	if (variants.length === 0) throw new Error(`NO_SCREENSHOTS:${SHOTS_ROOT} (run: bun ui/tools/design-shots.ts)`);
	return variants;
}

/** Final assistant text from a `pi --mode json` event stream. */
function finalText(jsonl: string): string {
	let text = '';
	for (const line of jsonl.split('\n')) {
		if (!line.startsWith('{')) continue;
		let event: { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue;
		const parts = (event.message.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '');
		if (parts.join('').trim()) text = parts.join('\n');
	}
	return text;
}

function parseReview(text: string, reviewer: string): Review {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) throw new Error(`REVIEW_NOT_JSON:${reviewer}`);
	const parsed = JSON.parse(text.slice(start, end + 1)) as Review;
	parsed.reviewer = reviewer;
	for (const screen of parsed.screens ?? []) {
		// A missing or zero parameter is "not applicable" for that variant, not a failing grade.
		const values = PARAMETERS.map(p => Number(screen.scores?.[p] ?? 0)).filter(v => v > 0);
		screen.total = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
	}
	return parsed;
}

const ATTEMPTS = 2;

async function callReviewer(model: string, variant: { name: string; files: string[] }, attempt: number): Promise<{ stdout: string; stderr: string; code: number }> {
	const prompt = `Review the attached wallet screenshots (variant: ${variant.name}) exactly per the attached rubric. Reply with the JSON object only, nothing else.`;
	// Low thinking: the answer is the scored JSON, not a chain of reasoning; some models otherwise spend the output budget thinking.
	// No tools: the reviewer must answer inline. With tools on, some models write the JSON to a file and reply with nothing.
	const args = ['-p', '--mode', 'json', '--no-tools', '--model', model, '--thinking', 'low', ...variant.files.map(f => `@${f}`), `@${RUBRIC}`, prompt];
	const proc = Bun.spawn(['pi', ...args], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
	const timer = setTimeout(() => proc.kill(), REVIEW_TIMEOUT_MS);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	clearTimeout(timer);
	const slug = `${model.replace(/[^a-z0-9.-]+/gi, '_')}.${variant.name}`;
	await writeFile(join(runDir, `${slug}${attempt > 1 ? `.attempt${attempt}` : ''}.jsonl`), stdout);
	return { stdout, stderr, code };
}

async function runReview(model: string, variant: { name: string; files: string[] }): Promise<Review> {
	const slug = `${model.replace(/[^a-z0-9.-]+/gi, '_')}.${variant.name}`;
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		const { stdout, stderr, code } = await callReviewer(model, variant, attempt);
		try {
			if (code !== 0) throw new Error(`REVIEW_FAILED:${model}:${variant.name}:exit=${code}\n${stderr.slice(-800)}`);
			const review = parseReview(finalText(stdout), model);
			if (!review.screens?.length) throw new Error(`REVIEW_EMPTY:${model}:${variant.name}`);
			await writeFile(join(runDir, `${slug}.json`), JSON.stringify(review, null, 2));
			return review;
		} catch (error) {
			// Empty answers and provider stream errors are transient; one retry usually lands.
			lastError = error;
			process.stdout.write(`retry ${model} ${variant.name} (${attempt}/${ATTEMPTS}): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function summarize(results: Array<{ model: string; variant: string; review: Review }>): string {
	const byScreen = new Map<string, Array<{ model: string; screen: ScreenReview }>>();
	for (const { model, variant, review } of results) {
		for (const screen of review.screens ?? []) {
			const key = `${variant}/${screen.file.replace(/^.*\//, '')}`;
			const list = byScreen.get(key) ?? [];
			list.push({ model, screen });
			byScreen.set(key, list);
		}
	}
	const lines: string[] = ['# Design review summary', '', `Reviewers: ${[...new Set(results.map(r => r.model))].join(', ')}`, ''];
	lines.push(`| screen | ${PARAMETERS.join(' | ')} | total |`);
	lines.push(`|---|${PARAMETERS.map(() => '---:').join('|')}|---:|`);
	const totals: number[] = [];
	for (const [key, entries] of [...byScreen.entries()].sort()) {
		const mean = (p: string): number => {
			const values = entries.map(e => Number(e.screen.scores?.[p] ?? 0)).filter(v => v > 0);
			return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
		};
		const row = PARAMETERS.map(mean);
		const scored = row.filter(v => v > 0);
		const total = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
		totals.push(total);
		lines.push(`| ${key} | ${row.join(' | ')} | **${total}** |`);
	}
	const grand = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0;
	lines.push('', `**Overall: ${grand} / 1000** (mean of screen totals across reviewers)`, '');
	lines.push('## Priority fixes by reviewer', '');
	for (const { model, variant, review } of results) {
		lines.push(`### ${model} · ${variant} · ${review.overall?.total ?? '?'}`, '', review.overall?.verdict ?? '', '');
		for (const fix of review.overall?.priority_fixes ?? []) lines.push(`- ${fix}`);
		lines.push('');
	}
	lines.push('## Issues per screen', '');
	for (const [key, entries] of [...byScreen.entries()].sort()) {
		lines.push(`### ${key}`, '');
		for (const { model, screen } of entries) {
			for (const issue of screen.top_issues ?? []) lines.push(`- (${model.split('/').pop()}) ${issue}`);
			for (const fix of screen.fixes ?? []) lines.push(`  - fix: ${fix}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/** Rebuild summary.md from the review JSON files already in the run directory. */
async function resummarize(): Promise<void> {
	const results: Array<{ model: string; variant: string; review: Review }> = [];
	for (const file of (await readdir(runDir)).filter(f => f.endsWith('.json')).sort()) {
		const review = JSON.parse(await readFile(join(runDir, file), 'utf8')) as Review;
		const variant = file.replace(/\.json$/, '').split('.').pop() ?? '';
		results.push({ model: review.reviewer, variant, review });
	}
	await writeFile(join(runDir, 'summary.md'), summarize(results));
	process.stdout.write(`summary rebuilt from ${results.length} reviews → ${join(runDir, 'summary.md')}\n`);
}

async function main(): Promise<void> {
	await mkdir(runDir, { recursive: true });
	if (process.argv.includes('--resummarize')) return resummarize();
	const variants = await listVariants();
	const jobs = models.flatMap(model => variants.map(variant => ({ model, variant })));
	process.stdout.write(`${jobs.length} review calls (${models.length} models × ${variants.length} variants) → ${runDir}\n`);
	const results: Array<{ model: string; variant: string; review: Review }> = [];
	const failures: string[] = [];
	await Promise.all(
		jobs.map(async ({ model, variant }) => {
			const t0 = Date.now();
			try {
				const review = await runReview(model, variant);
				results.push({ model, variant: variant.name, review });
				process.stdout.write(`ok   ${model} ${variant.name} total=${review.overall?.total ?? '?'} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
			} catch (error) {
				failures.push(`${model} ${variant.name}: ${error instanceof Error ? error.message : String(error)}`);
				process.stdout.write(`fail ${model} ${variant.name}\n`);
			}
		}),
	);
	const summary = summarize(results) + (failures.length ? `\n## Failed calls\n\n${failures.map(f => `- ${f}`).join('\n')}\n` : '');
	await writeFile(join(runDir, 'summary.md'), summary);
	process.stdout.write(`summary → ${join(runDir, 'summary.md')}\n`);
	if (results.length === 0) process.exitCode = 1;
}

main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
