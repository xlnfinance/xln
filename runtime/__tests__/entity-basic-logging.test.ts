import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { handleProposeEntityTx, handleVoteEntityTx } from '../entity/tx/handlers/basic';
import type { EntityState, EntityTx } from '../types';

test('basic entity proposal and vote traces stay behind structured logging', () => {
  const handler = readFileSync(join(process.cwd(), 'runtime/entity/tx/handlers/basic.ts'), 'utf8');
  const proposals = readFileSync(join(process.cwd(), 'runtime/entity/tx/proposals.ts'), 'utf8');

  expect(handler).toContain("const basicLog = createStructuredLogger('entity.basic');");
  expect(proposals).toContain("const proposalLog = createStructuredLogger('entity.basic');");
  expect(handler).not.toContain('console.');
  expect(proposals).not.toContain('console.');
  expect(handler).toContain('basicLog.debug');
  expect(proposals).toContain('proposalLog.debug');
});

const makeEntityState = (): EntityState => ({
  entityId: `0x${'aa'.repeat(32)}`,
  height: 0,
  timestamp: 123,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: ['alice', 'bob'],
    shares: { alice: 1n, bob: 1n },
    threshold: 2n,
  },
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: `0x${'11'.repeat(32)}`,
  entityEncPrivKey: `0x${'22'.repeat(32)}`,
  profile: {
    name: 'Basic Test Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

test('basic proposal and vote state transitions are unchanged', () => {
  const initial = makeEntityState();
  const action = { type: 'collective_message' as const, data: { message: 'ship mainnet discipline' } };
  const proposeTx = { type: 'propose' as const, data: { action, proposer: 'alice' } } satisfies EntityTx;
  const proposed = handleProposeEntityTx(initial, proposeTx).newState;
  const [proposalId, proposal] = Array.from(proposed.proposals.entries())[0]!;

  expect(initial.proposals.size).toBe(0);
  expect(proposed.messages).toEqual([]);
  expect(proposal.status).toBe('pending');
  expect(proposal.votes.get('alice')).toBe('yes');

  const voteTx = { type: 'vote' as const, data: { proposalId, voter: 'bob', choice: 'yes' as const } } satisfies EntityTx;
  const voted = handleVoteEntityTx(proposed, voteTx).newState;

  expect(voted.proposals.get(proposalId)?.status).toBe('executed');
  expect(voted.messages).toEqual(['[COLLECTIVE] ship mainnet discipline']);
  expect(voted.proposals.get(proposalId)?.votes.get('bob')).toBe('yes');
});
