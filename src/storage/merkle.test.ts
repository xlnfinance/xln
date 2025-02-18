import { strict as assert } from 'assert';
import { MerkleTree, StorageType, bufferToNibbles, nibblesToBuffer, createNode, hashNode, NodeValue } from './merkle';

describe('Merkle Storage', () => {
  let tree: MerkleTree;

  beforeEach(() => {
    tree = new MerkleTree();
  });

  describe('Nibble Operations', () => {
    it('bufferToNibbles converts correctly', () => {
      const buffer = Buffer.from([0xF0, 0x0F]);
      const nibbles4 = bufferToNibbles(buffer);
      assert.deepEqual(nibbles4, [15, 0, 0, 15]);

      const nibbles8 = bufferToNibbles(buffer, 8);
      assert.deepEqual(nibbles8, [0xF0, 0x0F]);
    });

    it('nibblesToBuffer converts correctly', () => {
      const nibbles4 = [15, 0, 0, 15];
      const buffer4 = nibblesToBuffer(nibbles4);
      assert.deepEqual(buffer4, Buffer.from([0xF0, 0x0F]));

      const nibbles8 = [0xF0, 0x0F];
      const buffer8 = nibblesToBuffer(nibbles8, 8);
      assert.deepEqual(buffer8, Buffer.from([0xF0, 0x0F]));
    });

    it('conversion is reversible', () => {
      const original = Buffer.from([0x12, 0x34, 0x56, 0x78]);
      const nibbles = bufferToNibbles(original);
      const converted = nibblesToBuffer(nibbles);
      assert.deepEqual(converted, original);
    });
  });

  describe('Node Operations', () => {
    it('createNode initializes correctly', () => {
      const node = createNode([1, 2, 3]);
      assert.deepEqual(node.nibbles, [1, 2, 3]);
      assert.ok(node.children);
      assert.equal(node.children?.size, 0);
      assert.equal(node.value, undefined);
      assert.equal(node.hash, undefined);
    });

    it('hashNode computes deterministic hash', () => {
      const node1 = createNode([1, 2, 3]);
      const node2 = createNode([1, 2, 3]);
      
      const hash1 = hashNode(node1);
      const hash2 = hashNode(node2);
      
      assert.deepEqual(hash1, hash2);
    });

    it('hashNode includes node value in hash', () => {
      const node1 = createNode([1, 2, 3]);
      const node2 = createNode([1, 2, 3]);
      
      node1.value = new Map([[StorageType.CURRENT_BLOCK, Buffer.from([1, 2, 3])]]);
      node2.value = new Map([[StorageType.CURRENT_BLOCK, Buffer.from([4, 5, 6])]]);
      
      const hash1 = hashNode(node1);
      const hash2 = hashNode(node2);
      
      assert.notDeepEqual(hash1, hash2);
    });
  });

  describe('Tree Operations', () => {
    it('setNode creates path correctly', () => {
      const path = [1, 2, 3];
      const value = new Map([[StorageType.CURRENT_BLOCK, Buffer.from([1, 2, 3])]]) as NodeValue;
      
      tree.setNode(path, value);
      const node = tree.getNode(path);
      
      assert.ok(node);
      assert.deepEqual(node?.value, value);
    });

    it('getRootHash changes with modifications', () => {
      const initialHash = tree.getRootHash();
      
      tree.setNode([1, 2, 3], new Map([[StorageType.CURRENT_BLOCK, Buffer.from([1])]]) as NodeValue);
      const newHash = tree.getRootHash();
      
      assert.notDeepEqual(newHash, initialHash);
    });

    it('overlay operations work correctly', () => {
      const overlayId = 'test';
      tree.createOverlay(overlayId);
      
      // Make changes through overlay
      const path = [1, 2, 3];
      const value = new Map([[StorageType.CURRENT_BLOCK, Buffer.from([1, 2, 3])]]) as NodeValue;
      
      const initialHash = tree.getRootHash();
      
      // Add to overlay and verify it's accessible
      tree.addToOverlay(overlayId, path, value);
      const overlayValue = tree.getNodeValue(path);
      assert.deepEqual(overlayValue, value);
      
      // Apply overlay and verify changes
      tree.applyOverlay(overlayId);
      const finalValue = tree.getNodeValue(path);
      assert.deepEqual(finalValue, value);
      
      const newHash = tree.getRootHash();
      assert.notDeepEqual(newHash, initialHash);
    });

    it('handles concurrent modifications through overlays', () => {
      const overlay1 = 'test1';
      const overlay2 = 'test2';
      
      tree.createOverlay(overlay1);
      tree.createOverlay(overlay2);
      
      // Make changes in both overlays
      const path1 = [1, 2, 3];
      const path2 = [1, 2, 4];
      
      const value1 = new Map([[StorageType.CURRENT_BLOCK, Buffer.from([1])]]) as NodeValue;
      const value2 = new Map([[StorageType.CURRENT_BLOCK, Buffer.from([2])]]) as NodeValue;
      
      // Add to overlays and verify they're accessible
      tree.addToOverlay(overlay1, path1, value1);
      tree.addToOverlay(overlay2, path2, value2);
      
      const overlay1Value = tree.getNodeValue(path1);
      const overlay2Value = tree.getNodeValue(path2);
      assert.deepEqual(overlay1Value, value1);
      assert.deepEqual(overlay2Value, value2);
      
      // Apply overlays and verify final state
      tree.applyOverlay(overlay1);
      tree.applyOverlay(overlay2);
      
      const final1Value = tree.getNodeValue(path1);
      const final2Value = tree.getNodeValue(path2);
      assert.deepEqual(final1Value, value1);
      assert.deepEqual(final2Value, value2);
    });
  });

  describe('Integration Tests', () => {
    it('handles complex tree operations', () => {
      // Create multiple paths
      const paths = [
        [1, 2, 3],
        [1, 2, 4],
        [2, 3, 4]
      ];
      
      const values = paths.map((_, i) => 
        new Map([[StorageType.CURRENT_BLOCK, Buffer.from([i + 1])]])
      );
      
      // Add all paths
      paths.forEach((path, i) => {
        tree.setNode(path, values[i]);
      });
      
      // Verify all paths
      paths.forEach((path, i) => {
        const node = tree.getNode(path);
        assert.deepEqual(node?.value, values[i]);
      });
      
      // Verify tree structure
      const root = tree.getNode([]);
      assert.equal(root?.children?.size, 2); // Should have nodes 1 and 2
      
      const node1 = tree.getNode([1]);
      assert.equal(node1?.children?.size, 1); // Should have node 2
      
      const node12 = tree.getNode([1, 2]);
      assert.equal(node12?.children?.size, 2); // Should have nodes 3 and 4
    });
  });
}); 