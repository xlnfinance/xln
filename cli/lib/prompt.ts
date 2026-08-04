import * as readline from 'node:readline';

export const ask = (question: string, hidden = false): Promise<string> =>
  new Promise(resolve => {
    if (!hidden || !process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, answer => {
        rl.close();
        resolve(String(answer || '').trim());
      });
      return;
    }
    const stdout = process.stdout;
    stdout.write(question);
    let value = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\n' || ch === '\r') {
          process.stdin.off('data', onData);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          process.stdin.off('data', onData);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
