#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Platform = 'ios' | 'android' | 'desktop' | 'extension';
type NativeBuildOptions = {
	flags: Set<string>;
	targets: Platform[];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FRONTEND = path.join(ROOT, 'frontend');
const BUILD_DIR = path.join(FRONTEND, 'build');
const NATIVE_DIR = path.join(ROOT, 'native');

function printHelp(): void {
	console.log(`XLN native build pipeline

Usage:
  bun scripts/native/build-platforms.ts [mobile|ios|android|desktop|extension|all] [--open] [--smoke] [--no-build] [--package]

Targets:
  mobile     Build/sync iOS + Android from frontend/build
  ios        Build/sync Capacitor iOS
  android    Build/sync Capacitor Android
  desktop    Prepare Electron shell; --open launches it
  extension  Prepare browser companion extension in native/extension/dist
  all        mobile + desktop + extension

Flags:
  --no-build  Reuse an existing frontend/build artifact
  --open      Open the native IDE/shell after sync
  --smoke     Launch desktop shell once and exit
  --package   Produce native debug packages when platform tooling is installed

Examples:
  bun run native:mobile
  bun run native:mobile -- --package
  bun run native:ios -- --open
  bun run native desktop --open
`);
}

function run(command: string, commandArgs: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
	const pretty = [command, ...commandArgs].join(' ');
	console.log(`\n$ ${pretty}`);
	const result = spawnSync(command, commandArgs, {
		cwd,
		env,
		stdio: 'inherit',
		shell: false,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${pretty} failed with exit code ${result.status ?? 'unknown'}`);
	}
}

export function expandTargets(input: string[]): Platform[] {
	const selected = input.length === 0 ? ['mobile'] : input;
	const platforms: Platform[] = [];
	const add = (...items: Platform[]) => {
		for (const item of items) {
			if (!platforms.includes(item)) platforms.push(item);
		}
	};

	for (const token of selected) {
		if (token === 'all') add('ios', 'android', 'desktop', 'extension');
		else if (token === 'mobile') add('ios', 'android');
		else if (token === 'ios' || token === 'android' || token === 'desktop' || token === 'extension') add(token);
		else throw new Error(`Unknown native target: ${token}`);
	}
	return platforms;
}

export function parseNativeBuildOptions(argv: string[]): NativeBuildOptions {
	const flags = new Set(argv.filter(arg => arg.startsWith('--')));
	const tokens = argv.filter(arg => !arg.startsWith('--'));
	return {
		flags,
		targets: expandTargets(tokens),
	};
}

export function requiredNativeToolCommands(targets: Platform[], flags: Set<string>): string[] {
	const required = new Set<string>();
	if (flags.has('--open') && targets.includes('ios')) required.add('xcodebuild');
	if (!flags.has('--package')) return [...required].sort();
	if (targets.includes('android')) required.add('java');
	if (targets.includes('ios')) required.add('xcodebuild');
	return [...required].sort();
}

function commandAvailable(command: string): boolean {
	const result = spawnSync(command, ['--version'], {
		stdio: 'ignore',
		shell: false,
	});
	return !result.error && result.status === 0;
}

function assertNativeToolingAvailable(targets: Platform[], flags: Set<string>): void {
	const missing = requiredNativeToolCommands(targets, flags).filter(command => !commandAvailable(command));
	if (missing.length === 0) return;
	throw new Error(
		`Missing native platform tooling: ${missing.join(', ')}. ` +
		'Install Java for Android packaging and full Xcode for iOS packaging/opening, or rerun without --package/--open.',
	);
}

function ensureFrontendBuild(flags: Set<string>): void {
	if (flags.has('--no-build')) {
		if (!existsSync(path.join(BUILD_DIR, 'index.html'))) {
			throw new Error('--no-build was requested, but frontend/build/index.html does not exist');
		}
		return;
	}
	run('bun', ['run', 'build'], FRONTEND);
}

function walkFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(fullPath));
		else if (entry.isFile()) files.push(fullPath);
	}
	return files;
}

function sanitizeNativeWebBuild(): void {
	for (const file of walkFiles(BUILD_DIR)) {
		if (path.basename(file) === '.DS_Store') {
			unlinkSync(file);
			continue;
		}
		if (path.extname(file) !== '.html') continue;
		const source = readFileSync(file, 'utf8');
		const sanitized = source.replace(
			/\n\s*<!-- Plausible Analytics -->\s*<script async src="https:\/\/plausible\.io\/js\/[^"]+"><\/script>\s*<script>\s*window\.plausible[\s\S]*?plausible\.init\(\)\s*<\/script>/g,
			'',
		);
		if (sanitized !== source) writeFileSync(file, sanitized);
	}
}

function pruneGeneratedNoise(root: string): void {
	for (const file of walkFiles(root)) {
		if (path.basename(file) === '.DS_Store') unlinkSync(file);
	}
}

function syncCapacitorPlatform(platform: 'ios' | 'android'): void {
	const platformDir = path.join(FRONTEND, platform);
	if (existsSync(platformDir)) {
		run('bunx', ['cap', 'sync', platform], FRONTEND);
		pruneGeneratedNoise(platform === 'ios'
			? path.join(FRONTEND, 'ios/App/App/public')
			: path.join(FRONTEND, 'android/app/src/main/assets/public'));
		return;
	}
	run('bunx', ['cap', 'add', platform], FRONTEND);
	pruneGeneratedNoise(platform === 'ios'
		? path.join(FRONTEND, 'ios/App/App/public')
		: path.join(FRONTEND, 'android/app/src/main/assets/public'));
}

function packageCapacitorPlatform(platform: 'ios' | 'android'): void {
	if (platform === 'android') {
		run('./gradlew', ['assembleDebug'], path.join(FRONTEND, 'android'));
		return;
	}
	run('xcodebuild', [
		'-workspace',
		'App.xcworkspace',
		'-scheme',
		'App',
		'-configuration',
		'Debug',
		'-destination',
		'generic/platform=iOS',
		'build',
	], path.join(FRONTEND, 'ios/App'));
}

function prepareDesktop(open: boolean, smoke: boolean): void {
	const main = path.join(NATIVE_DIR, 'desktop/main.cjs');
	if (!existsSync(main)) throw new Error(`Missing ${main}`);
	console.log('\nDesktop shell ready: native/desktop/main.cjs');
	if (open || smoke) {
		run('bunx', ['electron', 'native/desktop/main.cjs'], ROOT, {
			...process.env,
			...(smoke ? { XLN_ELECTRON_SMOKE: '1' } : {}),
		});
	}
}

function prepareExtension(): void {
	const sourceDir = path.join(NATIVE_DIR, 'extension');
	const distDir = path.join(sourceDir, 'dist');
	rmSync(distDir, { recursive: true, force: true });
	mkdirSync(distDir, { recursive: true });

	copyFileSync(path.join(sourceDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
	copyFileSync(path.join(sourceDir, 'extension-service-worker.js'), path.join(distDir, 'extension-service-worker.js'));

	const iconSource = path.join(BUILD_DIR, 'android-chrome-192x192.png');
	if (existsSync(iconSource)) {
		copyFileSync(iconSource, path.join(distDir, 'icon-128.png'));
	}

	const webDist = path.join(distDir, 'web');
	cpSync(BUILD_DIR, webDist, {
		recursive: true,
		filter: source => !source.includes(`${path.sep}.DS_Store`),
	});
	pruneGeneratedNoise(distDir);
	console.log('\nExtension companion ready: native/extension/dist');
}

async function main(): Promise<void> {
	const { flags, targets } = parseNativeBuildOptions(process.argv.slice(2));
	if (flags.has('--help') || flags.has('-h')) {
		printHelp();
		return;
	}

	assertNativeToolingAvailable(targets, flags);
	ensureFrontendBuild(flags);
	sanitizeNativeWebBuild();

	for (const target of targets) {
		if (target === 'ios' || target === 'android') {
			syncCapacitorPlatform(target);
			if (flags.has('--package')) packageCapacitorPlatform(target);
			if (flags.has('--open')) run('bunx', ['cap', 'open', target], FRONTEND);
		} else if (target === 'desktop') {
			prepareDesktop(flags.has('--open'), flags.has('--smoke'));
		} else if (target === 'extension') {
			prepareExtension();
		}
	}

	console.log(`\nXLN native pipeline complete: ${targets.join(', ')}`);
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
