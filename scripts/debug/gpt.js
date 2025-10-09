// creating unified output.txt of current source files, to be used as context for LLMs.
const fs = require('fs');
const path = require('path');

function buildFileTree(dir, baseDir) {
    const name = path.basename(dir);
    const stats = fs.statSync(dir);
    const node = { name, type: 'directory', children: [] };
    let fileContents = '';

    if (stats.isDirectory()) {
        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            if (fs.statSync(filePath).isDirectory()) {
                if (['node_modules', 'dist', '.git'].indexOf(file) != -1) return;

                //console.log(file)

                const result = buildFileTree(filePath, baseDir);
                node.children.push(result.node);
                fileContents += result.fileContents;
            } else if (path.extname(file) === '.ts' || 
            path.extname(file) === '.md' ||
            path.extname(file) === '.js' ||
            path.extname(file) === '.sol') {
                node.children.push({ name: file, type: 'file' });
                const relativePath = path.relative(baseDir, filePath);
                const content = fs.readFileSync(filePath, 'utf8');

                const prefix = baseDir.split('/').pop();
                fileContents += `--- ${prefix}/${relativePath} ---\n${content}\n`;
            }
        });
    }

    return { node, fileContents };
}

function printFileTree(node, prefix = '') {
    let result = `${prefix}${node.name}\n`;
    if (node.type === 'directory' && node.children) {
        node.children.forEach((child, index) => {
            const isLast = index === node.children.length - 1;
            result += printFileTree(
                child,
                `${prefix}${isLast ? '└── ' : '├── '}`
            );
        });
    }
    return result;
}

const srcPathSrc = path.resolve(__dirname, 'src');
const { node: fileTreeSrc, fileContents: fileContentsSrc } = buildFileTree(srcPathSrc, srcPathSrc);

const srcPathDocs = path.resolve(__dirname, 'docs');
const { node: fileTreeDocs, fileContents: fileContentsDocs } = buildFileTree(srcPathDocs, srcPathDocs);

const srcPathContracts = path.resolve(__dirname, 'contracts/contracts');
const { node: fileTreeContracts, fileContents: fileContentsContracts } = buildFileTree(srcPathContracts, srcPathContracts);

//${printFileTree(fileTreeSrc)}
const fullTreeOutput = `${printFileTree(fileTreeContracts)}\n\n  \n\n${printFileTree(fileTreeDocs)}`;
const fullOutput = `${fullTreeOutput}\n\n${fileContentsContracts}${fileContentsSrc}`;

const outputPath = path.join(__dirname, 'frontend/static/c.txt');
fs.writeFileSync(outputPath, fullOutput);

console.log(`Full output has been written to ${outputPath}`);
console.log(fullTreeOutput);
