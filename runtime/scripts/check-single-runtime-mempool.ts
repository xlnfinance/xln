import ts from 'typescript';

const typesPath = 'runtime/runtime/types.ts';
const source = await Bun.file(typesPath).text();
const file = ts.createSourceFile(typesPath, source, ts.ScriptTarget.Latest, true);
const env = file.statements.find(
  (node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === 'RuntimeState',
);

if (!env) throw new Error('RUNTIME_ENV_INTERFACE_MISSING');

const queueFields = env.members
  .filter(ts.isPropertySignature)
  .filter(member => {
    const name = member.name?.getText(file);
    if (name === 'runtimeMempool' && member.questionToken) {
      throw new Error('RUNTIME_LIVE_MEMPOOL_MUST_BE_REQUIRED');
    }
    return true;
  })
  .map(member => member.name?.getText(file))
  .filter(name => name === 'runtimeMempool' || name === 'runtimeInput');

if (queueFields.length !== 1 || queueFields[0] !== 'runtimeMempool') {
  throw new Error(
    `RUNTIME_LIVE_MEMPOOL_NOT_CANONICAL:expected=runtimeMempool:actual=${queueFields.join(',')}`,
  );
}

console.log('✅ RuntimeState has one live mempool: runtimeMempool');
