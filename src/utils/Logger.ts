// Logger.ts

import colors from '../app/colors';
import {stringify} from '../app/Channel'
import ENV from '../env';
// Logger.ts
function shortenLongWords(input: string) {
  return input.replace(/\b[a-zA-Z0-9]{60,}\b/g, match => match.slice(0, 60) + '...');
}
// Logger.ts


class Logger {
  private static idCounter: number = 0;
  public static _loggers: Logger[] = [];
  private static timeline: {time: number, user: string, level: string, event: string, objs: any}[] = [];
  private static states: {[key: string]: any} = {};
  private static paused: boolean = false;
  private static stepMode: boolean = false;
  private static columnWidth: number = 40;
  private static renderInterval: NodeJS.Timeout | null = null;

  private id!: number;
  private userAddress!: string;
  private color!: (text: string) => string;

  constructor(userAddress: string) {
    let logger = Logger._loggers.find(logger => logger.userAddress === userAddress);
    if (logger) return logger;

    this.initialize(userAddress);
  }

  private initialize(userAddress: string): void {
    this.id = ++Logger.idCounter;
    this.userAddress = userAddress;
    this.color = this.getColorForId(this.id);
    Logger._loggers.push(this);

    //if (!Logger.renderInterval) {
    //  Logger.renderInterval = setInterval(() => this.renderTimeline(), 1000);
    //}
  }

  private getColorForId(id: number): (text: string) => string {
    const colorFunctions = [colors.red, colors.green, colors.yellow, colors.blue, colors.magenta, colors.cyan];
    return colorFunctions[id % colorFunctions.length];
  }

  private formatMessage(level: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const shortAddress = this.userAddress;
    let objs = []
    let message = ''
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] === 'object') {
        objs.push(stringify(args[i]));
      } else {
        message += args[i] + ' ';
      }
    }


    
    const shortEvent = shortenLongWords(message.replace(/(\n)/gm, '')); //shortenLongWords(message.replace(/\s{10,}|(\r\n|\n|\r)/gm, ''))
    Logger.timeline.push({time: Date.now(), user: shortAddress, level, event: shortEvent, objs: objs});


    this.renderTimeline()
    return 'errorerrorlog'
  }

  private renderTimeline() {
    //console.clear();


    const users = Logger._loggers.map(logger => logger.userAddress);
    const header = users.map(user => user.padEnd(Logger.columnWidth)).join(' ');
    console.log(header);
    console.log('='.repeat(Logger.columnWidth * users.length));

    const events: string[][] = users.map(() => []);
    Logger.timeline.forEach(event => {
      //if ([ENV.nameToAddress['charlie'], ENV.nameToAddress['bob']].indexOf(event.user) == -1) return

      if (event.level === 'STATE') {
        console.log(shortenLongWords(event.event));
        return;
      };

      let lines = Math.floor(event.event.length / Logger.columnWidth);
      if (lines > 50) lines = 50;
      for (let shift = 0; shift <= lines+1 * Logger.columnWidth; shift += Logger.columnWidth){

        const line = users.map((_, index) => {
          let body;
          if (shift == 0) {
            body = `${event.level.padEnd(5)} | ${event.event.slice(shift, shift+Logger.columnWidth - 8)}`
          } else {
            const startAt = shift - 8;
            body = `${event.event.slice(startAt, startAt+Logger.columnWidth)}`
          }
        
          return (event.user == _ ? body : '').padEnd(Logger.columnWidth)


        }).join('|');
        const m = event.level ? event.level.toLocaleLowerCase() : 'log';
        (console as any)[m](line);
      }

      event.objs.map((obj: any) => {
        console.log(shortenLongWords(obj));
      })

    });

    Logger.timeline = [];
  }

  log(...args: any[]): void {
    const message = this.formatMessage('LOG', ...args);
    //console.log(this.color(message));
  }

  info(...args: any[]): void {
    const message = this.formatMessage('INFO', ...args);
    //console.log(this.color(message));
  }

  error(...args: any[]): void {
    const message = this.formatMessage('ERROR', ...args);
    //console.error(this.color(message));
  }

  //warn(...args: any[]): void {
   // const message = this.formatMessage('WARN', ...args);
    //console.warn(this.color(message));
  //}

  debug(...args: any[]): void {
    const message = this.formatMessage('DEBUG', ...args);
    //console.debug(this.color(message));
  }

  logState(addr: string, state: any): void {
    const oldState = Logger.states[addr] || {};
    const stateDiff = this.diffJson(state, oldState);

    let str = ''
    stateDiff.forEach(part => {
      if (part.added) str += part.added ? part.value : '';
      /*
      const color = part.added ? '\x1b[32m' : // Green for added
                    part.removed ? '\x1b[31m' : // Red for removed
                    '\x1b[0m'; // Reset for unchanged
                    
      if (color != '\x1b[0m') str+=(color + part.value + '\x1b[0m');*/
    });
    Logger.timeline.push({time: Date.now(), user: this.userAddress, level: 'STATE', event: `State diff ${addr}:\n${str}`, objs: []});
    Logger.states[addr] = state;

    this.renderTimeline()
    //console.log(str); // For newline at the end
  }


  diffJson(oldObj: any, newObj: any) {
    const diff = [];
    const oldStr = stringify(oldObj);
    const newStr = stringify(newObj);

    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    let i = 0, j = 0;
    while (i < oldLines.length && j < newLines.length) {
      if (oldLines[i] === newLines[j]) {
        diff.push({ value: oldLines[i] + '\n' });
        i++;
        j++;
      } else if (oldLines[i] !== newLines[j]) {
        diff.push({ removed: true, value: oldLines[i] + '\n' });
        diff.push({ added: true, value: newLines[j] + '\n' });
        i++;
        j++;
      }
    }

    while (i < oldLines.length) {
      diff.push({ removed: true, value: oldLines[i] + '\n' });
      i++;
    }

    while (j < newLines.length) {
      diff.push({ added: true, value: newLines[j] + '\n' });
      j++;
    }

    return diff;
  }
  logState2(state: any): void {
    const oldState = Logger.states[this.userAddress] || {};
    const stateDiff = stringify(state);
    Logger.states[this.userAddress] = state;
    this.log('State diff:', stateDiff);
  }

  static pauseExecution(): void {
    Logger.paused = true;
  }

  static resumeExecution(): void {
    Logger.paused = false;
    Logger.stepMode = false;
  }

  static toggleView(): void {
    if (Logger.renderInterval) {
      clearInterval(Logger.renderInterval);
      Logger.renderInterval = null;
    } else {
      Logger.renderInterval = setInterval(() => new Logger('').renderTimeline(), 1000);
    }
  }
}

export default Logger;