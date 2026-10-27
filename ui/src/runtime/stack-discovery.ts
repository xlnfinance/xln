import type { Stack } from './hosted';

/** Gate discovery always reaches a terminal view; a failure grants no usable stack. */
export async function settleStackDiscovery(
  discovery: Promise<Stack | null>,
): Promise<{ stack: Stack | null; error: string | null }> {
  try {
    return { stack: await discovery, error: null };
  } catch (error) {
    return { stack: null, error: error instanceof Error ? error.message : String(error) };
  }
}
