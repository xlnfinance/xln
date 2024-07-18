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
                const result = buildFileTree(filePath, baseDir);
                node.children.push(result.node);
                fileContents += result.fileContents;
            } else if (path.extname(file) === '.ts') {
                node.children.push({ name: file, type: 'file' });
                const relativePath = path.relative(baseDir, filePath);
                const content = fs.readFileSync(filePath, 'utf8');
                fileContents += `\n\n--- ${relativePath} ---\n\n${content}`;
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

const srcPath = path.resolve(__dirname, 'src');
const { node: fileTree, fileContents } = buildFileTree(srcPath, srcPath);
const treeOutput = printFileTree(fileTree);

const srcPath2 = path.resolve(__dirname, 'test');
const { node: fileTree2, fileContents: fileContents2 } = buildFileTree(srcPath2, srcPath2);

const fullOutput = `File Tree:\n\n${treeOutput}\n\nFile Contents:${fileContents} Tests: ${fileContents2}`;

const outputPath = path.join(__dirname, 'output.txt');
fs.writeFileSync(outputPath, fullOutput);

console.log(`Full output has been written to ${outputPath}`);
console.log('Here\'s a preview of the file tree:');
console.log(treeOutput);