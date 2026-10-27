import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { context, step, withClaim } from './fixtures';

// The explicit API origin below bypasses the browser-only wallet store.
mock.module('../runtime/store', () => ({ useApp: { getState: () => ({}) } }));
const { createTourCreditOfficerProbe } = await import('./use-credit-officer');

const fetchSpy = spyOn(globalThis, 'fetch');
afterEach(() => fetchSpy.mockReset());
afterAll(() => fetchSpy.mockRestore());

test('one probe per activation supplies explicit Borrow/Repay skips only when disabled', async () => {
  const read = createTourCreditOfficerProbe();
  fetchSpy.mockResolvedValue(Response.json({ success: true, enabled: false }));
  expect(read(false, '')).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
  const disabled = read(true, 'https://tour.test');
  expect(read(true, 'https://tour.test')).toBe(disabled);
  const observation = await disabled!;
  expect(observation.creditOfficerUnavailable).toBe('disabled on this stack');
  expect(observation.error).toBe('');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://tour.test/api/credit-officer/status');
  expect(step('borrow').skipReason?.(context(observation))).toContain('This bank has approved no borrowing facility');
  expect(step('repay').skipReason?.(context(observation))).toContain('No funded loan exists');
  expect(step('repay').skipReason?.(context({ ...observation, wallet: withClaim('loan', false) }))).toBe('');
  expect(read(true, 'https://tour.test')).toBe(disabled);
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  read(false, '');
  fetchSpy.mockResolvedValue(Response.json({ success: true, enabled: true }));
  const enabled = await read(true, 'https://tour.test')!;
  expect(enabled).toEqual({ creditOfficerUnavailable: '', error: '' });
  for (const id of ['borrow', 'repay']) {
    expect(step(id).skipReason?.(context(enabled))).toBe('');
    expect(step(id).done?.(context(enabled))).toBe(false);
  }
  expect(step('borrow').instruction(context(enabled))).toContain('wallet computes proof of work');
  expect(step('repay').instruction(context(enabled))).toContain('If no loan exists, return to Borrow');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test('malformed and failed status replies surface errors without claiming the officer is disabled', async () => {
  for (const reply of [
    Response.json({ success: true }),
    Response.json({ success: false, error: 'CREDIT_OFFICER_UNAVAILABLE' }, { status: 503 }),
    new Response('<html>Static host</html>', { headers: { 'Content-Type': 'text/html' } }),
  ]) {
    fetchSpy.mockResolvedValue(reply);
    const observation = await createTourCreditOfficerProbe()(true, 'https://tour.test')!;
    expect(observation.error).not.toBe('');
    for (const id of ['borrow', 'repay']) expect(step(id).skipReason?.(context(observation))).toBe('');
  }
});
