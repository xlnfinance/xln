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

                console.log(file)

                const result = buildFileTree(filePath, baseDir);
                node.children.push(result.node);
                fileContents += result.fileContents;
            } else if (path.extname(file) === '.ts' || path.extname(file) === '.sol') {
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

const srcPath = path.resolve(__dirname, 'src');
const { node: fileTree, fileContents } = buildFileTree(srcPath, srcPath);
const treeOutput = printFileTree(fileTree);

//const srcPath2 = path.resolve(__dirname, 'test');
//const { node: fileTree2, fileContents: fileContents2 } = buildFileTree(srcPath2, srcPath2);

const srcPath3 = path.resolve(__dirname, 'contracts/contracts');
const { node: fileTree3, fileContents: fileContents3 } = buildFileTree(srcPath3, srcPath3);



const fullOutput = `${fileContents3}${fileContents}`;

const outputPath = path.join(__dirname, 'output.txt');
fs.writeFileSync(outputPath, fullOutput);

console.log(`Full output has been written to ${outputPath}`);
console.log('Here\'s a preview of the file tree:');
console.log(treeOutput);
