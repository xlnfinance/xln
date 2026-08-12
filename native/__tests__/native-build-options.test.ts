import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	expandTargets,
	parseNativeBuildOptions,
	requiredNativeToolCommands,
	resolveIosXcodebuildProjectArgs,
} from '../../scripts/native/build-platforms';

describe('native build pipeline options', () => {
	test('defaults to both mobile shells from the shared frontend build', () => {
		expect(parseNativeBuildOptions([]).targets).toEqual(['ios', 'android']);
		expect(expandTargets(['mobile'])).toEqual(['ios', 'android']);
		expect(expandTargets(['all'])).toEqual(['ios', 'android', 'desktop', 'extension']);
	});

	test('rejects unknown targets before running platform tooling', () => {
		expect(() => expandTargets(['watch'])).toThrow('Unknown native target: watch');
	});

	test('only requires Java/Xcode for packaging or opening platform IDEs', () => {
		expect(requiredNativeToolCommands(['desktop'], new Set(['--smoke']))).toEqual([]);
		expect(requiredNativeToolCommands(['desktop'], new Set(['--package']))).toEqual(
			process.platform === 'darwin' ? ['codesign', 'spctl', 'xcrun'] : [],
		);
		expect(requiredNativeToolCommands(['android'], new Set(['--package']))).toEqual(['android-sdk', 'java']);
		expect(requiredNativeToolCommands(['ios'], new Set(['--open']))).toEqual(['xcodebuild']);
		expect(requiredNativeToolCommands(['ios', 'android'], new Set(['--package']))).toEqual(
			['android-sdk', 'codesign', 'java', 'xcodebuild'],
		);
	});

	test('supports fail-closed all-target release packaging', () => {
		const options = parseNativeBuildOptions(['all', '--package', '--smoke']);

		expect(options.targets).toEqual(['ios', 'android', 'desktop', 'extension']);
		expect(options.flags.has('--package')).toBe(true);
		expect(options.flags.has('--smoke')).toBe(true);
	});

	test('rejects the retired best-effort package path', () => {
		expect(() => parseNativeBuildOptions(['all', '--package', '--best-effort']))
			.toThrow('Unknown native flag: --best-effort');
	});

	test('uses the Capacitor SPM Xcode project when no workspace exists', () => {
		expect(resolveIosXcodebuildProjectArgs()).toEqual(['-project', 'App.xcodeproj']);
	});

	test('release packaging verifies signer identity, non-debug metadata, and notarization', () => {
		const source = readFileSync('scripts/native/build-platforms.ts', 'utf8');
		expect(source).toContain("['verify', '--verbose', '--print-certs', source]");
		expect(source).toContain('ANDROID_RELEASE_DEBUG_CERTIFICATE_FORBIDDEN');
		expect(source).toContain('ANDROID_RELEASE_CERTIFICATE_MISMATCH');
		expect(source).toContain('XLN_ANDROID_SIGNER_CERT_SHA256');
		expect(source).toContain("['dump', 'badging', source]");
		expect(source).toContain('ANDROID_RELEASE_DEBUGGABLE_FORBIDDEN');
		expect(source).toContain("versionName='${version}'");
		expect(source).toContain("source=Notarized Developer ID");
		expect(source).toContain('identityTeamId !== teamId');
		expect(source).toContain('MACOS_RELEASE_REQUIRES_DARWIN');
		expect(source).not.toContain('Skipping desktop package');
		expect(source).toContain("schema: 'xln:native-release-proof'");
		expect(source).toContain('sha256: fileSha256(artifactPath)');
	});
});
