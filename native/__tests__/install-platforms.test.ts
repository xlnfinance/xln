import { describe, expect, test } from 'bun:test';

import { INSTALL_CHANNELS } from '../../frontend/src/lib/install/platforms';

describe('install channel manifest', () => {
	test('covers every requested delivery surface with the local runtime first', () => {
		expect(INSTALL_CHANNELS.map(channel => channel.id)).toEqual(['cli', 'web', 'desktop', 'mobile', 'extension']);
	});

	test('states the fundamental web risk and uses the published GitHub launcher', () => {
		const web = INSTALL_CHANNELS.find(channel => channel.id === 'web');
		const cli = INSTALL_CHANNELS.find(channel => channel.id === 'cli');

		expect(web?.tradeoff).toContain('fundamental');
		expect(cli?.command).toContain('bunx --bun xlnfinance@https://github.com/xlnfinance/xln/releases/download/v');
		expect(cli?.command).toContain('/xlnfinance-');
		expect(cli?.benefit).toContain('full admin control');
		expect(INSTALL_CHANNELS.find(channel => channel.id === 'extension')?.platforms).toEqual(['Google Chrome']);
	});
});
