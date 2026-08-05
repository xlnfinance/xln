#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../deployment/canonical-json';
import {
	buildFrontendReleaseAssets,
} from '../deployment/frontend-release-files';
import { packageFrontendRelease } from '../deployment/frontend-release-package';
import {
	FRONTEND_RELEASE_MANIFEST_FILE,
	FRONTEND_SURFACE_IDS,
	type FrontendReleaseAsset,
	type FrontendReleaseManifest,
} from '../deployment/frontend-release-schema';

type Platform = 'ios' | 'android' | 'desktop' | 'extension';
type ArtifactStatus = 'built' | 'synced' | 'skipped' | 'reused';
type NativeArtifact = {
	target: Platform | 'runtime' | 'frontend' | 'frontend-release';
	kind: string;
	status: ArtifactStatus;
	path?: string;
	reason?: string;
};
type NativeBuildOptions = {
	flags: Set<string>;
	targets: Platform[];
};
type NativeFrontendBundle = Readonly<{
	releaseId: string;
	sourceCommit: string;
	productVersion: string;
	walletSha256: string;
	walletAssets: readonly FrontendReleaseAsset[];
	manifestPath: string;
}>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUN_EXECUTABLE = process.execPath;
const FRONTEND = path.join(ROOT, 'frontend');
const SURFACE_BUILD_ROOT = path.join(FRONTEND, 'build');
const NATIVE_WEB_DIR = path.join(FRONTEND, '.native-wallet-build');
const NATIVE_DIR = path.join(ROOT, 'native');
const DIST_DIR = path.join(NATIVE_DIR, 'dist');
const ARTIFACT_MANIFEST = path.join(DIST_DIR, 'native-artifacts.json');
const NATIVE_RELEASE_MANIFEST = path.join(DIST_DIR, 'frontend-release-manifest.json');
const APP_NAME = 'xln finance';
const DESKTOP_BUNDLE_ID = 'finance.xln.wallet.desktop';

function printHelp(): void {
	console.log(`XLN native build pipeline

Usage:
  bun scripts/native/build-platforms.ts [mobile|ios|android|desktop|extension|all] [--open] [--smoke] [--no-build] [--package] [--best-effort]

Targets:
  mobile     Build/sync iOS + Android from the manifest-bound wallet surface
  ios        Build/sync Capacitor iOS
  android    Build/sync Capacitor Android
  desktop    Prepare Electron shell; --open launches it
  extension  Prepare browser companion extension in native/extension/dist
  all        mobile + desktop + extension

Flags:
  --no-build     Repackage an existing unified build through the release manifest
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

function runBun(commandArgs: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
	run(BUN_EXECUTABLE, commandArgs, cwd, {
		...env,
		XLN_BUN_EXECUTABLE: BUN_EXECUTABLE,
	});
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
		...(result.error ? { error: result.error } : {}),
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
	const allowedFlags = new Set(['--help', '--open', '--smoke', '--no-build', '--package', '--best-effort']);
	const flags = new Set(argv.filter(arg => arg.startsWith('--')));
	for (const flag of flags) {
		if (!allowedFlags.has(flag)) throw new Error(`Unknown native flag: ${flag}`);
	}
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

const currentSourceCommit = (): string => {
	const result = runCapture('git', ['rev-parse', 'HEAD']);
	if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(result.output)) {
		throw new Error(`NATIVE_FRONTEND_SOURCE_COMMIT_INVALID:${result.output}`);
	}
	return result.output;
};

const assertNativeWalletCopy = (
	root: string,
	bundle: NativeFrontendBundle,
	target: Platform,
	exact: boolean,
): void => {
	const copied = buildFrontendReleaseAssets(root);
	const byPath = new Map(copied.map(asset => [asset.path, asset]));
	bundle.walletAssets.forEach(expected => {
		const actual = byPath.get(expected.path);
		if (canonicalJson(actual) !== canonicalJson(expected)) {
			throw new Error(`NATIVE_FRONTEND_WALLET_ASSET_MISMATCH:${target}:${expected.path}`);
		}
	});
	if (exact && copied.length !== bundle.walletAssets.length) {
		throw new Error(`NATIVE_FRONTEND_WALLET_EXTRA_ASSET:${target}`);
	}
};

const releaseBundle = (manifest: FrontendReleaseManifest): NativeFrontendBundle => ({
	releaseId: manifest.releaseId,
	sourceCommit: manifest.sourceCommit,
	productVersion: manifest.productVersion,
	walletSha256: manifest.surfaces.wallet.contentSha256,
	walletAssets: manifest.surfaces.wallet.assets,
	manifestPath: NATIVE_RELEASE_MANIFEST,
});

const copyManifestBoundWallet = (
	releaseRoot: string,
	manifest: FrontendReleaseManifest,
): NativeFrontendBundle => {
	rmSync(NATIVE_WEB_DIR, { recursive: true, force: true });
	cpSync(path.join(releaseRoot, manifest.surfaces.wallet.outputRoot), NATIVE_WEB_DIR, { recursive: true });
	mkdirSync(DIST_DIR, { recursive: true });
	copyFileSync(path.join(releaseRoot, FRONTEND_RELEASE_MANIFEST_FILE), NATIVE_RELEASE_MANIFEST);
	const bundle = releaseBundle(manifest);
	assertNativeWalletCopy(NATIVE_WEB_DIR, bundle, 'desktop', true);
	return bundle;
};

function ensureFrontendBuild(flags: Set<string>): { artifacts: NativeArtifact[]; bundle: NativeFrontendBundle } {
	const status: ArtifactStatus = flags.has('--no-build') ? 'reused' : 'built';
	if (!flags.has('--no-build')) {
		runBun(['run', 'build'], ROOT);
		runBun(['scripts/build-surfaces.ts'], FRONTEND);
	}
	const walletRoot = path.join(SURFACE_BUILD_ROOT, 'wallet');
	if (!existsSync(path.join(walletRoot, 'index.html'))) {
		throw new Error(`NATIVE_FRONTEND_BUILD_MISSING:${path.join(walletRoot, 'index.html')}`);
	}
	if (!existsSync(path.join(walletRoot, 'runtime.js'))) {
		throw new Error(`NATIVE_FRONTEND_RUNTIME_MISSING:${path.join(walletRoot, 'runtime.js')}`);
	}
	FRONTEND_SURFACE_IDS.forEach(surface => sanitizeWebBuild(path.join(SURFACE_BUILD_ROOT, surface)));
	const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'xln-native-release-'));
	try {
		const commit = currentSourceCommit();
		const releaseRoot = path.join(temporaryRoot, `${packageJsonVersion()}-${commit.slice(0, 12)}`);
		const manifest = packageFrontendRelease({
			buildRoot: SURFACE_BUILD_ROOT,
			releaseRoot,
			sourceCommit: commit,
			productVersion: packageJsonVersion(),
		});
		const bundle = copyManifestBoundWallet(releaseRoot, manifest);
		return {
			bundle,
			artifacts: [
				{ target: 'runtime', kind: 'browser-runtime', status, path: path.join(NATIVE_WEB_DIR, 'runtime.js') },
				{ target: 'frontend', kind: 'manifest-wallet', status, path: NATIVE_WEB_DIR },
				{ target: 'frontend-release', kind: 'release-manifest', status, path: NATIVE_RELEASE_MANIFEST },
			],
		};
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
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

function sanitizeWebBuild(root: string): void {
	for (const file of walkFiles(root)) {
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

function syncCapacitorPlatform(
	platform: 'ios' | 'android',
	bundle: NativeFrontendBundle,
): NativeArtifact {
	const platformDir = path.join(FRONTEND, platform);
	const capacitorEnv = { ...process.env, XLN_CAPACITOR_WEB_DIR: '.native-wallet-build' };
	const publicDir = platform === 'ios'
		? path.join(FRONTEND, 'ios/App/App/public')
		: path.join(FRONTEND, 'android/app/src/main/assets/public');
	if (existsSync(platformDir)) {
		runBun(['x', 'cap', 'sync', platform], FRONTEND, capacitorEnv);
		pruneGeneratedNoise(publicDir);
		assertNativeWalletCopy(publicDir, bundle, platform, false);
		return { target: platform, kind: 'capacitor-sync', status: 'synced', path: platformDir };
	}
	runBun(['x', 'cap', 'add', platform], FRONTEND, capacitorEnv);
	pruneGeneratedNoise(publicDir);
	assertNativeWalletCopy(publicDir, bundle, platform, false);
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
		const destination = path.join(DIST_DIR, `android/xln-finance-${packageJsonVersion()}-android-debug.apk`);
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
	const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
	if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
		throw new Error('NATIVE_PACKAGE_VERSION_MISSING');
	}
	return packageJson.version;
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

function packageDesktopApp(bundle: NativeFrontendBundle): NativeArtifact[] {
	if (process.platform !== 'darwin') {
		const reason = `desktop app bundle packaging is implemented for macOS; current platform is ${process.platform}`;
		console.warn(`Skipping desktop package: ${reason}`);
		return [{ target: 'desktop', kind: 'desktop-app', status: 'skipped', reason }];
	}

	const electronApp = path.join(ROOT, 'node_modules/electron/dist/Electron.app');
	if (!existsSync(electronApp)) {
		runBun(['x', 'electron', '--version'], ROOT);
	}
	if (!existsSync(electronApp)) {
		throw new Error(`Electron bootstrap completed without creating ${electronApp}`);
	}
	if (!existsSync(path.join(NATIVE_WEB_DIR, 'index.html'))) {
		throw new Error(`Missing ${path.join(NATIVE_WEB_DIR, 'index.html')}. Prepare manifest-bound wallet before packaging desktop.`);
	}
	if (!existsSync(path.join(NATIVE_WEB_DIR, 'runtime.js'))) {
		throw new Error(`Missing ${path.join(NATIVE_WEB_DIR, 'runtime.js')}. Prepare manifest-bound wallet before packaging desktop.`);
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
	cpSync(NATIVE_WEB_DIR, path.join(resourcesApp, 'frontend/build'), {
		recursive: true,
		filter: source => !source.includes(`${path.sep}.DS_Store`),
	});
	assertNativeWalletCopy(path.join(resourcesApp, 'frontend/build'), bundle, 'desktop', true);
	updateDesktopInfoPlist(appPath);
	pruneGeneratedNoise(appPath);
	const zipPath = path.join(DIST_DIR, 'desktop', `xln-finance-${packageJsonVersion()}-mac-${process.arch}.zip`);
	rmSync(zipPath, { force: true });
	run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], ROOT);
	return [
		{ target: 'desktop', kind: 'mac-app', status: 'built', path: appPath },
		{ target: 'desktop', kind: 'mac-zip', status: 'built', path: zipPath },
	];
}

function desktopLaunchCommand(artifact: NativeArtifact | null): [string, string[], string] {
	if (artifact?.status === 'built' && artifact.path && process.platform === 'darwin') {
		const executable = path.join(artifact.path, 'Contents/MacOS/Electron');
		if (existsSync(executable)) return [executable, [], ROOT];
	}
	return [BUN_EXECUTABLE, ['x', 'electron', 'native/desktop/main.cjs'], ROOT];
}

function prepareDesktop(flags: Set<string>, bundle: NativeFrontendBundle): NativeArtifact[] {
	const main = path.join(NATIVE_DIR, 'desktop/main.cjs');
	if (!existsSync(main)) throw new Error(`Missing ${main}`);
	const artifacts: NativeArtifact[] = [];
	const packageArtifacts = flags.has('--package') ? packageDesktopApp(bundle) : [];
	artifacts.push(...packageArtifacts);
	console.log('\nDesktop shell ready: native/desktop/main.cjs');
	if (flags.has('--open') || flags.has('--smoke')) {
		const appArtifact = packageArtifacts.find(artifact => artifact.kind === 'mac-app') || null;
		const [command, commandArgs, cwd] = desktopLaunchCommand(appArtifact);
		run(command, commandArgs, cwd, {
			...process.env,
			XLN_DESKTOP_WEB_DIR: NATIVE_WEB_DIR,
			...(flags.has('--smoke') ? { XLN_ELECTRON_SMOKE: '1' } : {}),
		});
	}
	if (packageArtifacts.length === 0) {
		artifacts.push({ target: 'desktop', kind: 'electron-shell', status: 'synced', path: main });
	}
	return artifacts;
}

function prepareExtension(flags: Set<string>, bundle: NativeFrontendBundle): NativeArtifact[] {
	const sourceDir = path.join(NATIVE_DIR, 'extension');
	const distDir = path.join(sourceDir, 'dist');
	rmSync(distDir, { recursive: true, force: true });
	mkdirSync(distDir, { recursive: true });

	copyFileSync(path.join(sourceDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
	copyFileSync(path.join(sourceDir, 'extension-service-worker.js'), path.join(distDir, 'extension-service-worker.js'));
	copyFileSync(path.join(sourceDir, 'extension-security.js'), path.join(distDir, 'extension-security.js'));

	const iconSource = path.join(NATIVE_WEB_DIR, 'android-chrome-192x192.png');
	if (existsSync(iconSource)) {
		copyFileSync(iconSource, path.join(distDir, 'icon-128.png'));
	}

	cpSync(NATIVE_WEB_DIR, distDir, {
		recursive: true,
		filter: source => source === NATIVE_WEB_DIR || !source.includes(`${path.sep}.DS_Store`),
	});
	copyFileSync(path.join(sourceDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
	copyFileSync(path.join(sourceDir, 'extension-service-worker.js'), path.join(distDir, 'extension-service-worker.js'));
	copyFileSync(path.join(sourceDir, 'extension-security.js'), path.join(distDir, 'extension-security.js'));
	pruneGeneratedNoise(distDir);
	assertNativeWalletCopy(distDir, bundle, 'extension', false);
	const artifacts: NativeArtifact[] = [
		{ target: 'extension', kind: 'chrome-extension-unpacked', status: 'built', path: distDir },
	];
	if (flags.has('--package')) {
		const zipPath = path.join(DIST_DIR, `chrome/xln-finance-chrome-${packageJsonVersion()}.zip`);
		mkdirSync(path.dirname(zipPath), { recursive: true });
		rmSync(zipPath, { force: true });
		run('zip', ['-q', '-r', zipPath, '.'], distDir);
		artifacts.push({ target: 'extension', kind: 'chrome-extension-zip', status: 'built', path: zipPath });
	}
	console.log('\nChrome extension ready: native/extension/dist');
	return artifacts;
}

function writeArtifactManifest(
	targets: Platform[],
	flags: Set<string>,
	artifacts: NativeArtifact[],
	frontendBundle: NativeFrontendBundle,
): void {
	mkdirSync(DIST_DIR, { recursive: true });
	const unavailableTools = requiredNativeToolCommands(targets, flags)
		.filter(command => !commandAvailable(command))
		.map(command => ({ command, reason: nativeToolMissingReason(command) }));
	writeFileSync(ARTIFACT_MANIFEST, JSON.stringify({
		generatedAt: new Date().toISOString(),
		repoRoot: ROOT,
		targets,
		flags: [...flags].sort(),
		frontendRelease: {
			releaseId: frontendBundle.releaseId,
			sourceCommit: frontendBundle.sourceCommit,
			productVersion: frontendBundle.productVersion,
			walletSha256: frontendBundle.walletSha256,
			manifestPath: frontendBundle.manifestPath,
		},
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
	const frontendBuild = ensureFrontendBuild(flags);
	artifacts.push(...frontendBuild.artifacts);

	for (const target of targets) {
		if (target === 'ios' || target === 'android') {
			artifacts.push(syncCapacitorPlatform(target, frontendBuild.bundle));
			if (flags.has('--package')) artifacts.push(packageCapacitorPlatform(target, flags));
			if (flags.has('--open')) runBun(['x', 'cap', 'open', target], FRONTEND);
		} else if (target === 'desktop') {
			artifacts.push(...prepareDesktop(flags, frontendBuild.bundle));
		} else if (target === 'extension') {
			artifacts.push(...prepareExtension(flags, frontendBuild.bundle));
		}
	}

	writeArtifactManifest(targets, flags, artifacts, frontendBuild.bundle);
	console.log(`\nxln native pipeline complete: ${targets.join(', ')}`);
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
