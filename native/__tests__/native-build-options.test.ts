import { describe, expect, test } from 'bun:test';
import {
	expandTargets,
	parseNativeBuildOptions,
	requiredNativeToolCommands,
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
		expect(requiredNativeToolCommands(['android'], new Set(['--package']))).toEqual(['java']);
		expect(requiredNativeToolCommands(['ios'], new Set(['--open']))).toEqual(['xcodebuild']);
		expect(requiredNativeToolCommands(['ios', 'android'], new Set(['--package']))).toEqual(['java', 'xcodebuild']);
	});
});
