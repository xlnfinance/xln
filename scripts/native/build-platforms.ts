#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
type ArtifactStatus = 'built' | 'synced' | 'reused';
type NativeArtifact = {
	target: Platform | 'runtime' | 'frontend';
	kind: string;
	status: ArtifactStatus;
	path?: string;
	releaseTrust?: 'signed' | 'signed-notarized';
	proofPath?: string;
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
const APP_NAME = 'xln finance';
const DESKTOP_BUNDLE_ID = 'finance.xln.wallet.desktop';

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
  --no-build     Reuse an existing frontend/build artifact
  --open         Open the native IDE/shell after sync
  --smoke        Launch desktop shell once and exit
  --package      Produce signed release packages; missing signing/notarization fails closed

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

function runCapture(
	command: string,
	commandArgs: string[],
	cwd = ROOT,
	env: NodeJS.ProcessEnv = process.env,
): { status: number | null; output: string; error?: Error } {
	const result = spawnSync(command, commandArgs, {
		cwd,
		env: command === 'java' ? javaEnv() : env,
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
	const allowedFlags = new Set(['--help', '-h', '--no-build', '--open', '--smoke', '--package']);
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
	if (targets.includes('ios') && flags.has('--package')) required.add('codesign');
	if (targets.includes('desktop') && process.platform === 'darwin') {
		required.add('codesign');
		required.add('xcrun');
		required.add('spctl');
	}
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
	throw new Error(
		`Missing native platform tooling: ${missing.map(nativeToolMissingReason).join(' | ')}. ` +
		'Install a JDK for Android packaging and full Xcode for iOS packaging/opening, or rerun without --package/--open.',
	);
}

const requiredEnvironment = (names: readonly string[]): void => {
	const missing = names.filter(name => !String(process.env[name] || '').trim());
	if (missing.length > 0) throw new Error(`NATIVE_RELEASE_CREDENTIALS_MISSING:${missing.join(',')}`);
};

export const assertNativeReleaseCredentials = (targets: Platform[], flags: Set<string>): void => {
	if (!flags.has('--package')) return;
	if (targets.includes('android')) {
		requiredEnvironment([
			'XLN_ANDROID_KEYSTORE_PATH',
			'XLN_ANDROID_KEYSTORE_PASSWORD',
			'XLN_ANDROID_KEY_ALIAS',
			'XLN_ANDROID_KEY_PASSWORD',
			'XLN_ANDROID_SIGNER_CERT_SHA256',
		]);
		const keystore = String(process.env.XLN_ANDROID_KEYSTORE_PATH);
		if (!existsSync(keystore)) throw new Error(`ANDROID_RELEASE_KEYSTORE_MISSING:${keystore}`);
	}
	if (targets.includes('ios')) {
		requiredEnvironment(['XLN_IOS_DEVELOPMENT_TEAM']);
	}
	if (targets.includes('desktop') && process.platform === 'darwin') {
		requiredEnvironment([
			'XLN_MACOS_CODESIGN_IDENTITY',
			'XLN_MACOS_NOTARY_KEY_PATH',
			'XLN_MACOS_NOTARY_KEY_ID',
			'XLN_MACOS_NOTARY_ISSUER_ID',
		]);
		const notaryKey = String(process.env.XLN_MACOS_NOTARY_KEY_PATH);
		if (!existsSync(notaryKey)) throw new Error(`MACOS_NOTARY_KEY_MISSING:${notaryKey}`);
	}
};

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
		}
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

function resolveIosSigningArgs(): string[] {
	const envTeam = String(process.env.XLN_IOS_DEVELOPMENT_TEAM || '').trim();
	if (envTeam) return ['-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${envTeam}`, 'CODE_SIGN_STYLE=Automatic'];
	throw new Error(
		'Missing iOS release signing team. Set XLN_IOS_DEVELOPMENT_TEAM=<TEAM_ID> for release packaging.',
	);
}

const fileSha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

const writeReleaseProof = (
	artifactPath: string,
	proof: Record<string, unknown>,
): string => {
	const proofPath = `${artifactPath}.release-proof.json`;
	writeFileSync(proofPath, `${JSON.stringify({
		schema: 'xln:native-release-proof',
		artifact: path.basename(artifactPath),
		sha256: fileSha256(artifactPath),
		version: packageJsonVersion(),
		release: true,
		...proof,
	}, null, 2)}\n`);
	return proofPath;
};

const assertCapacitorPackageTools = (platform: 'ios' | 'android'): void => {
	const requiredTools = platform === 'android' ? ['java', 'android-sdk'] : ['xcodebuild'];
	const missingTools = requiredTools.filter(tool => !commandAvailable(tool));
	if (missingTools.length > 0) {
		const reason = missingTools.map(nativeToolMissingReason).join(' | ');
		throw new Error(`Cannot package ${platform}: ${reason}`);
	}
};

const androidReleaseVersionCode = (version: string): number => {
	const parts = version.split('.').map(value => Number(value));
	if (parts.length !== 3 || !parts.every(Number.isSafeInteger)) {
		throw new Error(`ANDROID_RELEASE_VERSION_INVALID:${version}`);
	}
	return (parts[0]! * 1_000_000) + (parts[1]! * 1_000) + parts[2]!;
};

const verifyAndroidRelease = (
	source: string,
	version: string,
	env: NodeJS.ProcessEnv,
): string => {
	const androidHome = existingAndroidHome();
	if (!androidHome) throw new Error('ANDROID_RELEASE_SDK_MISSING');
	const apkSigner = path.join(androidHome, 'build-tools/36.0.0/apksigner');
	const aapt2 = path.join(androidHome, 'build-tools/36.0.0/aapt2');
	if (!existsSync(apkSigner)) throw new Error(`ANDROID_APKSIGNER_MISSING:${apkSigner}`);
	if (!existsSync(aapt2)) throw new Error(`ANDROID_AAPT2_MISSING:${aapt2}`);
	const signer = runCapture(apkSigner, ['verify', '--verbose', '--print-certs', source], ROOT, env);
	if (signer.error || signer.status !== 0) throw new Error(`ANDROID_RELEASE_SIGNATURE_INVALID:${signer.output}`);
	if (/android debug/i.test(signer.output)) throw new Error('ANDROID_RELEASE_DEBUG_CERTIFICATE_FORBIDDEN');
	const digest = signer.output.match(/certificate SHA-256 digest:\s*([0-9a-f:]+)/i)?.[1]
		?.replaceAll(':', '').toLowerCase();
	if (!digest || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('ANDROID_RELEASE_CERTIFICATE_DIGEST_MISSING');
	const expectedDigest = String(process.env.XLN_ANDROID_SIGNER_CERT_SHA256 || '')
		.replaceAll(':', '').toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expectedDigest) || digest !== expectedDigest) {
		throw new Error(`ANDROID_RELEASE_CERTIFICATE_MISMATCH:expected=${expectedDigest}:actual=${digest}`);
	}
	const badging = runCapture(aapt2, ['dump', 'badging', source], ROOT, env);
	if (badging.error || badging.status !== 0) throw new Error(`ANDROID_RELEASE_MANIFEST_INVALID:${badging.output}`);
	if (badging.output.includes('application-debuggable')) throw new Error('ANDROID_RELEASE_DEBUGGABLE_FORBIDDEN');
	if (!badging.output.includes("package: name='finance.xln.wallet'")) throw new Error('ANDROID_RELEASE_PACKAGE_ID_INVALID');
	if (!badging.output.includes(`versionName='${version}'`)) throw new Error(`ANDROID_RELEASE_VERSION_MISMATCH:${version}`);
	return digest;
};

const packageAndroidRelease = (): NativeArtifact => {
	const version = packageJsonVersion();
	const env = {
		...androidEnv(),
		XLN_ANDROID_VERSION_NAME: version,
		XLN_ANDROID_VERSION_CODE: String(androidReleaseVersionCode(version)),
	};
	run('./gradlew', ['assembleRelease'], path.join(FRONTEND, 'android'), env);
	const source = path.join(FRONTEND, 'android/app/build/outputs/apk/release/app-release.apk');
	if (!existsSync(source)) throw new Error(`Signed Android release APK was not produced at ${source}`);
	const certificateDigest = verifyAndroidRelease(source, version, env);
	const destination = path.join(DIST_DIR, `android/xln-finance-${version}-android-release-signed.apk`);
	mkdirSync(path.dirname(destination), { recursive: true });
	copyFileSync(source, destination);
	const proofPath = writeReleaseProof(destination, {
		platform: 'android', signed: true, notarized: false, debuggable: false,
		applicationId: 'finance.xln.wallet', signerCertificateSha256: certificateDigest,
	});
	return { target: 'android', kind: 'release-apk', status: 'built', path: destination, releaseTrust: 'signed', proofPath };
};

const packageIosRelease = (): NativeArtifact => {
	const derivedDataPath = path.join(DIST_DIR, 'ios-derived-data');
	const iosAppDir = path.join(FRONTEND, 'ios/App');
	rmSync(derivedDataPath, { recursive: true, force: true });
	run('xcodebuild', [
		...resolveIosXcodebuildProjectArgs(iosAppDir),
		'-scheme',
		'App',
		'-configuration',
		'Release',
		'-destination',
		'generic/platform=iOS',
		'-derivedDataPath',
		derivedDataPath,
		...resolveIosSigningArgs(),
		'build',
	], iosAppDir);
	const appPath = path.join(derivedDataPath, 'Build/Products/Release-iphoneos/App.app');
	if (!existsSync(appPath)) throw new Error(`Signed iOS release app was not produced at ${appPath}`);
	run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], ROOT);
	const signature = runCapture('codesign', ['-dv', '--verbose=4', appPath]);
	const teamId = signature.output.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1];
	if (signature.status !== 0 || !teamId || teamId !== String(process.env.XLN_IOS_DEVELOPMENT_TEAM)) {
		throw new Error(`IOS_RELEASE_SIGNATURE_IDENTITY_INVALID:${signature.output}`);
	}
	return { target: 'ios', kind: 'release-ios-app', status: 'built', path: appPath, releaseTrust: 'signed' };
};

function packageCapacitorPlatform(platform: 'ios' | 'android', _flags: Set<string>): NativeArtifact {
	assertCapacitorPackageTools(platform);
	return platform === 'android' ? packageAndroidRelease() : packageIosRelease();
}

function packageJsonVersion(): string {
	const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
	const version = String(packageJson.version || '');
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`NATIVE_RELEASE_VERSION_INVALID:${version}`);
	return version;
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

function packageDesktopApp(): NativeArtifact[] {
	if (process.platform !== 'darwin') {
		throw new Error(`MACOS_RELEASE_REQUIRES_DARWIN:current=${process.platform}`);
	}

	const electronApp = path.join(ROOT, 'node_modules/electron/dist/Electron.app');
	if (!existsSync(electronApp)) {
		run('bunx', ['electron', '--version'], ROOT);
	}
	if (!existsSync(electronApp)) {
		throw new Error(`Electron bootstrap completed without creating ${electronApp}`);
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
	const identity = String(process.env.XLN_MACOS_CODESIGN_IDENTITY);
	run('codesign', ['--deep', '--force', '--options', 'runtime', '--timestamp', '--sign', identity, appPath], ROOT);
	run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], ROOT);
	const submissionZip = path.join(DIST_DIR, 'desktop', `.notary-submission-${process.arch}.zip`);
	rmSync(submissionZip, { force: true });
	run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, submissionZip], ROOT);
	run('xcrun', [
		'notarytool', 'submit', submissionZip,
		'--key', String(process.env.XLN_MACOS_NOTARY_KEY_PATH),
		'--key-id', String(process.env.XLN_MACOS_NOTARY_KEY_ID),
		'--issuer', String(process.env.XLN_MACOS_NOTARY_ISSUER_ID),
		'--wait',
	], ROOT);
	run('xcrun', ['stapler', 'staple', appPath], ROOT);
	run('xcrun', ['stapler', 'validate', appPath], ROOT);
	const assessment = runCapture('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
	if (assessment.error || assessment.status !== 0 || !/source=Notarized Developer ID/i.test(assessment.output)) {
		throw new Error(`MACOS_NOTARIZATION_ASSESSMENT_INVALID:${assessment.output}`);
	}
	const signature = runCapture('codesign', ['-dv', '--verbose=4', appPath]);
	const teamId = signature.output.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1];
	const identityTeamId = identity.match(/\(([A-Z0-9]+)\)\s*$/)?.[1];
	if (
		signature.status !== 0 ||
		!teamId ||
		!identity.startsWith('Developer ID Application:') ||
		identityTeamId !== teamId
	) {
		throw new Error(`MACOS_RELEASE_SIGNATURE_IDENTITY_INVALID:${signature.output}`);
	}
	rmSync(submissionZip, { force: true });
	const zipPath = path.join(DIST_DIR, 'desktop', `xln-finance-${packageJsonVersion()}-mac-${process.arch}-signed-notarized.zip`);
	rmSync(zipPath, { force: true });
	run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], ROOT);
	const proofPath = writeReleaseProof(zipPath, {
		platform: `macos-${process.arch}`,
		signed: true,
		notarized: true,
		debuggable: false,
		teamId,
		codesignIdentity: identity,
	});
	return [
		{ target: 'desktop', kind: 'mac-app', status: 'built', path: appPath, releaseTrust: 'signed-notarized' },
		{
			target: 'desktop', kind: 'mac-zip', status: 'built', path: zipPath,
			releaseTrust: 'signed-notarized', proofPath,
		},
	];
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
	const packageArtifacts = flags.has('--package') ? packageDesktopApp() : [];
	artifacts.push(...packageArtifacts);
	console.log('\nDesktop shell ready: native/desktop/main.cjs');
	if (flags.has('--open') || flags.has('--smoke')) {
		const appArtifact = packageArtifacts.find(artifact => artifact.kind === 'mac-app') || null;
		const [command, commandArgs, cwd] = desktopLaunchCommand(appArtifact);
		run(command, commandArgs, cwd, {
			...process.env,
			...(flags.has('--smoke') ? { XLN_ELECTRON_SMOKE: '1' } : {}),
		});
	}
	if (packageArtifacts.length === 0) {
		artifacts.push({ target: 'desktop', kind: 'electron-shell', status: 'synced', path: main });
	}
	return artifacts;
}

function prepareExtension(flags: Set<string>): NativeArtifact[] {
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

	cpSync(BUILD_DIR, distDir, {
		recursive: true,
		filter: source => source === BUILD_DIR || !source.includes(`${path.sep}.DS_Store`),
	});
	copyFileSync(path.join(sourceDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
	copyFileSync(path.join(sourceDir, 'extension-service-worker.js'), path.join(distDir, 'extension-service-worker.js'));
	copyFileSync(path.join(sourceDir, 'extension-security.js'), path.join(distDir, 'extension-security.js'));
	pruneGeneratedNoise(distDir);
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
	assertNativeReleaseCredentials(targets, flags);
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
			artifacts.push(...prepareExtension(flags));
		}
	}

	writeArtifactManifest(targets, flags, artifacts);
	console.log(`\nxln native pipeline complete: ${targets.join(', ')}`);
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
