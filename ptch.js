const fs = require('fs');
const readline = require('readline');

const changes = [];
let currentChange = null;

function applyChanges() {
    const fileChanges = {};
    const lineShifts = {};

    // Sort changes by file and then by ascending start line
    changes.sort((a, b) => {
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return a.start - b.start;
    });

    for (const change of changes) {
        if (!fileChanges[change.file]) {
            fileChanges[change.file] = fs.readFileSync(change.file, 'utf8').split('\n');
            lineShifts[change.file] = 0;
        }

        const lines = fileChanges[change.file];
        const shift = lineShifts[change.file];

        if (change.type === 'remove') {
            const adjustedStart = change.start + shift;
            const adjustedEnd = change.end + shift;
            if (isNaN(adjustedStart) || isNaN(adjustedEnd)) {
                console.error(`Invalid adjusted line range: start=${adjustedStart}, end=${adjustedEnd}`);
                continue;
            }
            console.log(`Removing lines ${adjustedStart}-${adjustedEnd} from ${change.file}:`);
            console.log(lines.slice(adjustedStart - 1, adjustedEnd).join('\n'));
            lines.splice(adjustedStart - 1, adjustedEnd - adjustedStart + 1);
            lineShifts[change.file] -= (adjustedEnd - adjustedStart + 1);
        } else if (change.type === 'add') {
            const adjustedStart = change.start + shift;
            if (isNaN(adjustedStart)) {
                console.error(`Invalid adjusted start line: ${adjustedStart}`);
                continue;
            }
            console.log(`Adding at line ${adjustedStart} in ${change.file}:`);
            const contextStart = Math.max(0, adjustedStart - 4);
            console.log('Context:');
            console.log(lines.slice(contextStart, adjustedStart - 1).join('\n'));
            console.log('New content:');
            console.log(change.content.join('\n'));
            lines.splice(adjustedStart - 1, 0, ...change.content);
            lineShifts[change.file] += change.content.length;
        }
    }

    for (const [file, lines] of Object.entries(fileChanges)) {
        fs.writeFileSync(file, lines.join('\n'));
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    if (line.startsWith('--- ')) {
        if (currentChange) {
            changes.push(currentChange);
        }
        const parts = line.substring(4).split(':');
        const file = parts[0];
        if (parts[1].includes(' ')) {
            const [start, end] = parts[1].split(' ').map(Number);
            if (isNaN(start) || isNaN(end)) {
                console.error(`Invalid line range: ${parts[1]} in file ${file}`);
                currentChange = null;
                return;
            }
            currentChange = { file, type: 'remove', start, end };
            console.log(`Preparing to remove lines ${start}-${end} from ${file}`);
        } else {
            const start = Number(parts[1]);
            if (isNaN(start)) {
                console.error(`Invalid line number: ${parts[1]} in file ${file}`);
                currentChange = null;
                return;
            }
            currentChange = { file, type: 'add', start, content: [] };
            console.log(`Preparing to add content at line ${parts[1]} in ${file}`);
        }
    } else if (currentChange && currentChange.type === 'add') {
        currentChange.content.push(line);
    }
});

rl.on('close', () => {
    if (currentChange) {
        changes.push(currentChange);
    }
    try {
        applyChanges();
        console.log('Patch applied successfully.');
    } catch (error) {
        console.error('Error applying patch:', error);
    }
});