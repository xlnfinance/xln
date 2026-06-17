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
type ArtifactStatus = 'built' | 'synced' | 'skipped' | 'reused';
type NativeArtifact = {
	target: Platform | 'runtime' | 'frontend';
	kind: string;
	status: ArtifactStatus;
	path?: string;
	reason?: string;
};
type NativeBuildOptions = {
	flags: Set<string>;
	targets: Platform[];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FRONTEND = path.join(ROOT, 'frontend');
const BUILD_DIR = path.join(FRONTEND, 'build');
const NATIVE_DIR = path.join(ROOT, 'native');
const DIST_DIR = path.join(NATIVE_DIR, 'dist');
const ARTIFACT_MANIFEST = path.join(DIST_DIR, 'native-artifacts.json');
const APP_NAME = 'XLN Wallet';
const DESKTOP_BUNDLE_ID = 'finance.xln.wallet.desktop';

function printHelp(): void {
	console.log(`XLN native build pipeline

Usage:
  bun scripts/native/build-platforms.ts [mobile|ios|android|desktop|extension|all] [--open] [--smoke] [--no-build] [--package] [--best-effort]

Targets:
  mobile     Build/sync iOS + Android from frontend/build
  ios        Build/sync Capacitor iOS
  android    Build/sync Capacitor Android
  desktop    Prepare Electron shell; --open launches it
  extension  Prepare browser companion extension in native/extension/dist
  all        mobile + desktop + extension

Flags:
  --no-build     Reuse an existing frontend/build artifact
  --open         Open the native IDE/shell after sync
  --smoke        Launch desktop shell once and exit
  --package      Produce installable debug/dev packages when platform tooling is installed
  --best-effort  Continue other targets when mobile platform tooling is unavailable

Examples:
  bun run native:mobile
  bun run native:mobile -- --package
  bun run native:package
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

function existingJavaHome(): string | null {
	const candidates = [
		process.env.JAVA_HOME,
		'/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
		'/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
		'/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
		'/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
	].filter((value): value is string => typeof value === 'string' && value.length > 0);
	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, 'bin/java'))) return candidate;
	}
	return null;
}

function javaEnv(): NodeJS.ProcessEnv {
	const javaHome = existingJavaHome();
	if (!javaHome) return process.env;
	return {
		...process.env,
		JAVA_HOME: javaHome,
		PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
	};
}

function existingAndroidHome(): string | null {
	const candidates = [
		process.env.ANDROID_HOME,
		process.env.ANDROID_SDK_ROOT,
		path.join(process.env.HOME || '', 'Library/Android/sdk'),
		'/opt/homebrew/share/android-commandlinetools',
	].filter((value): value is string => typeof value === 'string' && value.length > 0);
	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, 'platforms/android-36')) && existsSync(path.join(candidate, 'build-tools/36.0.0'))) {
			return candidate;
		}
	}
	return null;
}

function androidEnv(): NodeJS.ProcessEnv {
	const base = javaEnv();
	const androidHome = existingAndroidHome();
	if (!androidHome) return base;
	return {
		...base,
		ANDROID_HOME: androidHome,
		ANDROID_SDK_ROOT: androidHome,
		PATH: `${path.join(androidHome, 'platform-tools')}${path.delimiter}${base.PATH || ''}`,
	};
}

function runCapture(command: string, commandArgs: string[], cwd = ROOT): { status: number | null; output: string; error?: Error } {
	const result = spawnSync(command, commandArgs, {
		cwd,
		env: command === 'java' ? javaEnv() : process.env,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: false,
	});
	return {
		status: result.status,
		output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
		error: result.error,
	};
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
	if (targets.includes('android')) {
		required.add('android-sdk');
		required.add('java');
	}
	if (targets.includes('ios')) required.add('xcodebuild');
	return [...required].sort();
}

function commandVersionArgs(command: string): string[] {
	if (command === 'xcodebuild') return ['-version'];
	if (command === 'java') return ['-version'];
	return ['--version'];
}

function commandAvailable(command: string): boolean {
	if (command === 'android-sdk') return existingAndroidHome() !== null;
	const result = spawnSync(command, commandVersionArgs(command), {
		env: command === 'java' ? javaEnv() : process.env,
		stdio: 'ignore',
		shell: false,
	});
	return !result.error && result.status === 0;
}

function nativeToolMissingReason(command: string): string {
	if (command === 'android-sdk') {
		return 'Android SDK platform android-36 and build-tools 36.0.0 are required; install with sdkmanager "platforms;android-36" "build-tools;36.0.0"';
	}
	const result = runCapture(command, commandVersionArgs(command));
	const output = result.output.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' ');
	if (command === 'xcodebuild') {
		return output || 'full Xcode is required; CommandLineTools is not enough for iOS packaging';
	}
	if (command === 'java') {
		return output || 'JDK is required for Android Gradle packaging';
	}
	return output || `${command} is not available`;
}

function assertNativeToolingAvailable(targets: Platform[], flags: Set<string>): void {
	const missing = requiredNativeToolCommands(targets, flags).filter(command => !commandAvailable(command));
	if (missing.length === 0) return;
	if (flags.has('--best-effort') && flags.has('--package')) {
		const openRequiresXcode = flags.has('--open') && targets.includes('ios') && missing.includes('xcodebuild');
		if (!openRequiresXcode) {
			console.warn(
				`Native package tooling unavailable for some targets: ${missing.map(nativeToolMissingReason).join(' | ')}`,
			);
			console.warn('Continuing because --best-effort was requested.');
			return;
		}
	}
	throw new Error(
		`Missing native platform tooling: ${missing.map(nativeToolMissingReason).join(' | ')}. ` +
		'Install a JDK for Android packaging and full Xcode for iOS packaging/opening, or rerun without --package/--open.',
	);
}

function ensureFrontendBuild(flags: Set<string>): NativeArtifact[] {
	if (flags.has('--no-build')) {
		if (!existsSync(path.join(BUILD_DIR, 'index.html'))) {
			throw new Error('--no-build was requested, but frontend/build/index.html does not exist');
		}
		if (!existsSync(path.join(BUILD_DIR, 'runtime.js'))) {
			throw new Error('--no-build was requested, but frontend/build/runtime.js does not exist');
		}
		return [
			{ target: 'runtime', kind: 'browser-runtime', status: 'reused', path: path.join(BUILD_DIR, 'runtime.js') },
			{ target: 'frontend', kind: 'sveltekit-static', status: 'reused', path: BUILD_DIR },
		];
	}
	run('bun', ['run', 'build'], ROOT);
	run('bun', ['run', 'build'], FRONTEND);
	return [
		{ target: 'runtime', kind: 'browser-runtime', status: 'built', path: path.join(BUILD_DIR, 'runtime.js') },
		{ target: 'frontend', kind: 'sveltekit-static', status: 'built', path: BUILD_DIR },
	];
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

function syncCapacitorPlatform(platform: 'ios' | 'android'): NativeArtifact {
	const platformDir = path.join(FRONTEND, platform);
	if (existsSync(platformDir)) {
		run('bunx', ['cap', 'sync', platform], FRONTEND);
		pruneGeneratedNoise(platform === 'ios'
			? path.join(FRONTEND, 'ios/App/App/public')
			: path.join(FRONTEND, 'android/app/src/main/assets/public'));
		return { target: platform, kind: 'capacitor-sync', status: 'synced', path: platformDir };
	}
	run('bunx', ['cap', 'add', platform], FRONTEND);
	pruneGeneratedNoise(platform === 'ios'
		? path.join(FRONTEND, 'ios/App/App/public')
		: path.join(FRONTEND, 'android/app/src/main/assets/public'));
	return { target: platform, kind: 'capacitor-add', status: 'synced', path: platformDir };
}

export function resolveIosXcodebuildProjectArgs(iosAppDir = path.join(FRONTEND, 'ios/App')): string[] {
	if (existsSync(path.join(iosAppDir, 'App.xcworkspace'))) return ['-workspace', 'App.xcworkspace'];
	if (existsSync(path.join(iosAppDir, 'App.xcodeproj'))) return ['-project', 'App.xcodeproj'];
	throw new Error(`Missing iOS Xcode project in ${iosAppDir}`);
}

function readConfiguredIosDevelopmentTeam(iosAppDir: string): string {
	const projectFile = path.join(iosAppDir, 'App.xcodeproj/project.pbxproj');
	if (!existsSync(projectFile)) return '';
	const project = readFileSync(projectFile, 'utf8');
	const match = project.match(/DEVELOPMENT_TEAM = ([A-Z0-9]+);/);
	return match?.[1] || '';
}

function resolveIosSigningArgs(iosAppDir: string): string[] {
	const envTeam = String(process.env.XLN_IOS_DEVELOPMENT_TEAM || '').trim();
	if (envTeam) return ['-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${envTeam}`, 'CODE_SIGN_STYLE=Automatic'];
	if (readConfiguredIosDevelopmentTeam(iosAppDir)) return [];
	throw new Error(
		'Missing iOS development team. Set Signing & Capabilities > Team in frontend/ios/App/App.xcodeproj, ' +
		'or rerun with XLN_IOS_DEVELOPMENT_TEAM=<TEAM_ID> bun run native:ios:package.',
	);
}

function packageCapacitorPlatform(platform: 'ios' | 'android', flags: Set<string>): NativeArtifact {
	const requiredTools = platform === 'android' ? ['java', 'android-sdk'] : ['xcodebuild'];
	const missingTools = requiredTools.filter(tool => !commandAvailable(tool));
	if (missingTools.length > 0) {
		const reason = missingTools.map(nativeToolMissingReason).join(' | ');
		if (flags.has('--best-effort')) {
			console.warn(`Skipping ${platform} package: ${reason}`);
			return { target: platform, kind: 'debug-package', status: 'skipped', reason };
		}
		throw new Error(`Cannot package ${platform}: ${reason}`);
	}

	if (platform === 'android') {
		run('./gradlew', ['assembleDebug'], path.join(FRONTEND, 'android'), androidEnv());
		const source = path.join(FRONTEND, 'android/app/build/outputs/apk/debug/app-debug.apk');
		const destination = path.join(DIST_DIR, 'android/xln-wallet-debug.apk');
		if (!existsSync(source)) throw new Error(`Android debug APK was not produced at ${source}`);
		mkdirSync(path.dirname(destination), { recursive: true });
		copyFileSync(source, destination);
		return { target: 'android', kind: 'debug-apk', status: 'built', path: destination };
	}

	const derivedDataPath = path.join(DIST_DIR, 'ios-derived-data');
	const iosAppDir = path.join(FRONTEND, 'ios/App');
	const signingArgs = resolveIosSigningArgs(iosAppDir);
	rmSync(derivedDataPath, { recursive: true, force: true });
	run('xcodebuild', [
		...resolveIosXcodebuildProjectArgs(iosAppDir),
		'-scheme',
		'App',
		'-configuration',
		'Debug',
		'-destination',
		'generic/platform=iOS',
		'-derivedDataPath',
		derivedDataPath,
		...signingArgs,
		'build',
	], iosAppDir);
	const appPath = path.join(derivedDataPath, 'Build/Products/Debug-iphoneos/App.app');
	if (!existsSync(appPath)) throw new Error(`iOS debug app was not produced at ${appPath}`);
	return { target: 'ios', kind: 'debug-ios-app', status: 'built', path: appPath };
}

function packageJsonVersion(): string {
	try {
		const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
		return String(packageJson.version || '1.0.0');
	} catch {
		return '1.0.0';
	}
}

function setPlistString(plist: string, key: string, value: string): string {
	const escapedValue = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const pattern = new RegExp(`(<key>${key}</key>\\s*)<string>[^<]*</string>`);
	if (pattern.test(plist)) return plist.replace(pattern, `$1<string>${escapedValue}</string>`);
	return insertBeforeRootDictClose(plist, `\t<key>${key}</key>\n\t<string>${escapedValue}</string>\n`);
}

function insertBeforeRootDictClose(plist: string, block: string): string {
	const closeIndex = plist.lastIndexOf('</dict>');
	if (closeIndex === -1) throw new Error('Invalid Info.plist: root dict close tag not found');
	return `${plist.slice(0, closeIndex)}${block}${plist.slice(closeIndex)}`;
}

function ensureDesktopUrlScheme(plist: string): string {
	if (plist.includes('<string>xln</string>')) return plist;
	const urlTypes = [
		'\t<key>CFBundleURLTypes</key>',
		'\t<array>',
		'\t\t<dict>',
		'\t\t\t<key>CFBundleURLName</key>',
		`\t\t\t<string>${DESKTOP_BUNDLE_ID}</string>`,
		'\t\t\t<key>CFBundleURLSchemes</key>',
		'\t\t\t<array>',
		'\t\t\t\t<string>xln</string>',
		'\t\t\t</array>',
		'\t\t</dict>',
		'\t</array>',
	].join('\n');
	return insertBeforeRootDictClose(plist, `${urlTypes}\n`);
}

function updateDesktopInfoPlist(appPath: string): void {
	const plistPath = path.join(appPath, 'Contents/Info.plist');
	let plist = readFileSync(plistPath, 'utf8');
	plist = setPlistString(plist, 'CFBundleName', APP_NAME);
	plist = setPlistString(plist, 'CFBundleDisplayName', APP_NAME);
	plist = setPlistString(plist, 'CFBundleIdentifier', DESKTOP_BUNDLE_ID);
	plist = setPlistString(plist, 'CFBundleShortVersionString', packageJsonVersion());
	plist = setPlistString(plist, 'CFBundleVersion', packageJsonVersion());
	plist = ensureDesktopUrlScheme(plist);
	writeFileSync(plistPath, plist);
}

function packageDesktopApp(): NativeArtifact {
	if (process.platform !== 'darwin') {
		const reason = `desktop app bundle packaging is implemented for macOS; current platform is ${process.platform}`;
		console.warn(`Skipping desktop package: ${reason}`);
		return { target: 'desktop', kind: 'desktop-app', status: 'skipped', reason };
	}

	const electronApp = path.join(ROOT, 'node_modules/electron/dist/Electron.app');
	if (!existsSync(electronApp)) {
		throw new Error(`Missing Electron.app at ${electronApp}. Run bun install or bunx electron --version first.`);
	}
	if (!existsSync(path.join(BUILD_DIR, 'index.html'))) {
		throw new Error(`Missing ${path.join(BUILD_DIR, 'index.html')}. Build frontend before packaging desktop.`);
	}
	if (!existsSync(path.join(BUILD_DIR, 'runtime.js'))) {
		throw new Error(`Missing ${path.join(BUILD_DIR, 'runtime.js')}. Build runtime before packaging desktop.`);
	}

	const platformTag = `mac-${process.arch}`;
	const outputDir = path.join(DIST_DIR, 'desktop', platformTag);
	const appPath = path.join(outputDir, `${APP_NAME}.app`);
	const resourcesApp = path.join(appPath, 'Contents/Resources/app');
	rmSync(appPath, { recursive: true, force: true });
	mkdirSync(outputDir, { recursive: true });
	cpSync(electronApp, appPath, { recursive: true });
	rmSync(resourcesApp, { recursive: true, force: true });
	mkdirSync(resourcesApp, { recursive: true });
	writeFileSync(path.join(resourcesApp, 'package.json'), JSON.stringify({
		name: 'xln-wallet-desktop',
		version: packageJsonVersion(),
		main: 'native/desktop/main.cjs',
		private: true,
	}, null, 2));
	cpSync(path.join(NATIVE_DIR, 'desktop'), path.join(resourcesApp, 'native/desktop'), { recursive: true });
	cpSync(BUILD_DIR, path.join(resourcesApp, 'frontend/build'), {
		recursive: true,
		filter: source => !source.includes(`${path.sep}.DS_Store`),
	});
	updateDesktopInfoPlist(appPath);
	pruneGeneratedNoise(appPath);
	return { target: 'desktop', kind: 'mac-app', status: 'built', path: appPath };
}

function desktopLaunchCommand(artifact: NativeArtifact | null): [string, string[], string] {
	if (artifact?.status === 'built' && artifact.path && process.platform === 'darwin') {
		const executable = path.join(artifact.path, 'Contents/MacOS/Electron');
		if (existsSync(executable)) return [executable, [], ROOT];
	}
	return ['bunx', ['electron', 'native/desktop/main.cjs'], ROOT];
}

function prepareDesktop(flags: Set<string>): NativeArtifact[] {
	const main = path.join(NATIVE_DIR, 'desktop/main.cjs');
	if (!existsSync(main)) throw new Error(`Missing ${main}`);
	const artifacts: NativeArtifact[] = [];
	const packageArtifact = flags.has('--package') ? packageDesktopApp() : null;
	if (packageArtifact) artifacts.push(packageArtifact);
	console.log('\nDesktop shell ready: native/desktop/main.cjs');
	if (flags.has('--open') || flags.has('--smoke')) {
		const [command, commandArgs, cwd] = desktopLaunchCommand(packageArtifact);
		run(command, commandArgs, cwd, {
			...process.env,
			...(flags.has('--smoke') ? { XLN_ELECTRON_SMOKE: '1' } : {}),
		});
	}
	if (!packageArtifact) {
		artifacts.push({ target: 'desktop', kind: 'electron-shell', status: 'synced', path: main });
	}
	return artifacts;
}

function prepareExtension(): NativeArtifact {
	const sourceDir = path.join(NATIVE_DIR, 'extension');
	const distDir = path.join(sourceDir, 'dist');
	rmSync(distDir, { recursive: true, force: true });
	mkdirSync(distDir, { recursive: true });

	copyFileSync(path.join(sourceDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
	copyFileSync(path.join(sourceDir, 'extension-service-worker.js'), path.join(distDir, 'extension-service-worker.js'));
	copyFileSync(path.join(sourceDir, 'extension-security.js'), path.join(distDir, 'extension-security.js'));

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
	return { target: 'extension', kind: 'browser-extension', status: 'built', path: distDir };
}

function writeArtifactManifest(targets: Platform[], flags: Set<string>, artifacts: NativeArtifact[]): void {
	mkdirSync(DIST_DIR, { recursive: true });
	const unavailableTools = requiredNativeToolCommands(targets, flags)
		.filter(command => !commandAvailable(command))
		.map(command => ({ command, reason: nativeToolMissingReason(command) }));
	writeFileSync(ARTIFACT_MANIFEST, JSON.stringify({
		generatedAt: new Date().toISOString(),
		repoRoot: ROOT,
		targets,
		flags: [...flags].sort(),
		artifacts,
		unavailableTools,
	}, null, 2));
	console.log(`\nArtifact manifest: ${ARTIFACT_MANIFEST}`);
}

async function main(): Promise<void> {
	const { flags, targets } = parseNativeBuildOptions(process.argv.slice(2));
	if (flags.has('--help') || flags.has('-h')) {
		printHelp();
		return;
	}

	assertNativeToolingAvailable(targets, flags);
	const artifacts: NativeArtifact[] = [];
	artifacts.push(...ensureFrontendBuild(flags));
	sanitizeNativeWebBuild();

	for (const target of targets) {
		if (target === 'ios' || target === 'android') {
			artifacts.push(syncCapacitorPlatform(target));
			if (flags.has('--package')) artifacts.push(packageCapacitorPlatform(target, flags));
			if (flags.has('--open')) run('bunx', ['cap', 'open', target], FRONTEND);
		} else if (target === 'desktop') {
			artifacts.push(...prepareDesktop(flags));
		} else if (target === 'extension') {
			artifacts.push(prepareExtension());
		}
	}

	writeArtifactManifest(targets, flags, artifacts);
	console.log(`\nXLN native pipeline complete: ${targets.join(', ')}`);
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
