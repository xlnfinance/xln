interface MerkleNode {
  path: Buffer;
  hash: Buffer | null;
  children: Map<number, MerkleNode>;
  values: Map<Buffer, any> | null;
}

export function formatTree(node: MerkleNode | null, prefix = ''): string {
  if (!node) return 'null';

  const path = node.path.toString('hex');
  const pathDisplay = path ? `[${path}]` : '[]';
  
  // Only show node type if we can determine it with certainty based on path length
  const nodeType = path.length === 64 ? 'Entity' : 
                  path.length === 0 ? 'Server' : 
                  path.length === 32 ? 'Signer' : '';
  
  // Determine if node is a branch based on children
  const isBranch = node.children.size > 0;
  const nodeKind = isBranch ? 'Branch' : 'Leaf';
  
  // Get shortened hash
  const hash = node.hash ? node.hash.toString('hex').slice(0, 8) : 'no_hash';

  let result = `${prefix}${pathDisplay}${nodeType ? `[${nodeType}]` : ''}[${nodeKind} ${hash}]`;

  if (isBranch) {
    const childKeys = Array.from(node.children.keys()).sort((a: number, b: number) => a - b);
    result += ` (${childKeys.length} children)\n`;
    if (childKeys.length > 0) {
      result += `${prefix}  ↳ Nibbles: ${childKeys.join(',')}\n`;
      for (const key of childKeys) {
        const child = node.children.get(key);
        if (child) {
          result += formatTree(child, prefix + '  ');
        }
      }
    }
  } else if (node.values) {
    const valueMap = node.values || new Map();
    const entries = Array.from(valueMap.entries()).sort(([a], [b]) => {
      return parseInt(a.toString('hex'), 16) - parseInt(b.toString('hex'), 16);
    });
    
    result += ` (${entries.length} values)\n`;
    for (const [key, value] of entries) {
      const shortKey = key.toString('hex').slice(0, 16);
      const valueObj = value instanceof Map ? 
        Object.fromEntries(value) : 
        value;
      result += `${prefix}  ├─${shortKey}... ${JSON.stringify(valueObj)}\n`;
    }
  }

  return result;
} 