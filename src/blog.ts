import crypto from 'crypto';

type NodeType = 'post' | 'comment';

interface Node {
  id: string;
  type: NodeType;
  content: string;
  author: string;
  timestamp: number;
  parentId?: string;
}

interface DAGNode {
  data: Node;
  hash: string;
  children: Set<string>;
}

interface DAGState {
  nodes: Map<string, DAGNode>;
  idToHash: Map<string, string>;
}

// Pure functions for DAG operations
const createEmptyDAGState = (): DAGState => ({
  nodes: new Map(),
  idToHash: new Map()
});

const computeHash = (data: any): string => 
  crypto.createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex')
    .slice(0, 8);

const addNodeToDAG = (state: DAGState, node: Node): DAGState => {
  const newState = {
    nodes: new Map(state.nodes),
    idToHash: new Map(state.idToHash)
  };

  const dagNode: DAGNode = {
    data: node,
    hash: computeHash(node),
    children: new Set()
  };

  // Store the node
  newState.nodes.set(dagNode.hash, dagNode);
  newState.idToHash.set(node.id, dagNode.hash);

  // Update parent's children if exists
  if (node.parentId) {
    const parentHash = newState.idToHash.get(node.parentId);
    if (parentHash) {
      const parent = newState.nodes.get(parentHash);
      if (parent) {
        parent.children.add(dagNode.hash);
      }
    }
  }

  return newState;
};

const findRootHashes = (state: DAGState): Set<string> => {
  const rootHashes = new Set(state.nodes.keys());
  for (const node of state.nodes.values()) {
    for (const childHash of node.children) {
      rootHashes.delete(childHash);
    }
  }
  return rootHashes;
};

const renderNode = (
  state: DAGState,
  hash: string,
  depth = 0,
  prefix = ''
): string[] => {
  const node = state.nodes.get(hash);
  if (!node) return [];

  const indent = '  '.repeat(depth);
  const icon = node.data.type === 'post' ? '📝' : '💬';
  const line = `${prefix}${icon} [${node.hash}] ${node.data.author}: ${node.data.content}`;
  
  const childArray = Array.from(node.children);
  const childLines = childArray.flatMap((childHash, i) => {
    const isLast = i === childArray.length - 1;
    const childPrefix = prefix + (isLast ? '└─' : '├─');
    return renderNode(state, childHash, depth + 1, childPrefix);
  });

  return [line, ...childLines];
};

const renderDAG = (state: DAGState): string => {
  const rootHashes = findRootHashes(state);
  const lines = Array.from(rootHashes).flatMap(hash => renderNode(state, hash));
  return [
    '\n=== DAG Visualization ===\n',
    ...lines,
    '\n=== End of DAG ===\n'
  ].join('\n');
};

// Enhanced demo with more interactions
const runDemo = () => {
  console.log('Running enhanced demo...\n');
  let state = createEmptyDAGState();

  // Create a discussion about programming
  const discussion = [
    {
      id: '1',
      type: 'post' as NodeType,
      content: 'What\'s your favorite programming language?',
      author: 'Alice',
      timestamp: Date.now()
    },
    {
      id: '2',
      type: 'comment' as NodeType,
      content: 'Python for its simplicity!',
      author: 'Bob',
      parentId: '1',
      timestamp: Date.now() + 1000
    },
    {
      id: '3',
      type: 'comment' as NodeType,
      content: 'Rust for safety and performance',
      author: 'Charlie',
      parentId: '1',
      timestamp: Date.now() + 2000
    },
    {
      id: '4',
      type: 'comment' as NodeType,
      content: 'I agree, Python is great for beginners',
      author: 'David',
      parentId: '2',
      timestamp: Date.now() + 3000
    },
    {
      id: '5',
      type: 'post' as NodeType,
      content: 'Best practices for async programming?',
      author: 'Eve',
      timestamp: Date.now() + 4000
    },
    {
      id: '6',
      type: 'comment' as NodeType,
      content: 'Use async/await patterns',
      author: 'Alice',
      parentId: '5',
      timestamp: Date.now() + 5000
    },
    {
      id: '7',
      type: 'comment' as NodeType,
      content: 'Don\'t forget error handling!',
      author: 'Bob',
      parentId: '6',
      timestamp: Date.now() + 6000
    }
  ];

  // Add nodes sequentially and show the DAG evolution
  discussion.forEach((node, index) => {
    console.log(`Step ${index + 1}: Adding ${node.type} by ${node.author}`);
    state = addNodeToDAG(state, node);
    console.log(renderDAG(state));
  });
};

// Run the demo
runDemo();