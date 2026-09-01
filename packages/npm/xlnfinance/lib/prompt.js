import * as readline from 'node:readline';

export const ask = (question, hidden = false) => new Promise((resolve) => {
  if (!hidden || !process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
    return;
  }

  process.stdout.write(question);
  let value = '';
  const finish = (result) => {
    process.stdin.off('data', onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
    resolve(result.trim());
  };
  const onData = (chunk) => {
    for (const character of chunk.toString('utf8')) {
      if (character === '\n' || character === '\r') return finish(value);
      if (character === '\u0003') {
        process.stdin.off('data', onData);
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
      else value += character;
    }
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
});
