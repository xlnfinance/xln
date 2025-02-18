import { expect } from 'chai';
import { createServerState, runSelfTest } from '../server.js';
import { ServerState } from '../server.js';

// Test suite for server.ts
describe('Server Tests', () => {
  let state: ServerState;

  beforeEach(() => {
    state = createServerState();
  });

  it('should run self-test without errors', async () => {
    state = await runSelfTest(state);
    
    // Verify basic state properties
    expect(state).to.have.property('block').that.is.a('number');
    expect(state.block).to.be.greaterThan(0, 'Block number should be incremented');
    
    // Verify merkle root
    expect(state).to.have.property('merkleRoot');
    const merkleRoot = state.merkleRoot!; // We know it's defined after runSelfTest
    expect(merkleRoot).to.be.instanceOf(Buffer);
    expect(merkleRoot.length).to.equal(32, 'Merkle root should be 32 bytes');
    
    // Verify merkle store
    expect(state.merkleStore).to.exist;
    expect(state.merkleStore.getMerkleRoot()).to.deep.equal(merkleRoot);
    
    // Verify pool is empty after processing
    expect(state.pool.size).to.equal(0, 'Pool should be empty after processing');
  });
}); 