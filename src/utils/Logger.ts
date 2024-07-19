// src/utils/Logger.ts
import { stringify } from '../app/Channel';

class Logger {
  static idCounter: number = 0;
  public static _loggers: Logger[] = [];
  
  id?: number;
  userAddress?: string;


  constructor(userAddress: string) {
    let logger = Logger._loggers.find(logger => logger.userAddress === userAddress);
    if (logger) {
      return logger;
    }

    console.log("new logger "+userAddress)

    this.id = ++Logger.idCounter;
    this.userAddress = userAddress;

    Logger._loggers.push(this);
  }

  private getColorForId(id: number): string {
    const colors = [
      '\x1b[31m', // red
      '\x1b[32m', // green
      '\x1b[33m', // yellow
      '\x1b[34m', // blue
      '\x1b[35m', // magenta
      '\x1b[36m', // cyan
      '\x1b[37m', // white
    ];
    return colors[id % colors.length];
  }

  private formatMessage(level: string, ...args: any[]): string {
    const color = this.getColorForId(this.id!);
    const paddedId = this.id!.toString().padStart(2, '0');
    const timestamp = new Date().toISOString();
    let formattedMessage = `${color}[${paddedId}:${this.userAddress!.slice(0, 6)}]\x1b[0m [${level}] [${timestamp}]`;

    const messageParts = args.map(arg => (typeof arg === 'object' ? stringify(arg) : arg));
    formattedMessage += ' ' + messageParts.join(' ');

    return formattedMessage;
  }

  log(...args: any[]): void {
    console.log(this.formatMessage('LOG', ...args));
  }

  info(...args: any[]): void {
    console.log(this.formatMessage('INFO', ...args));
  }

  error(...args: any[]): void {
    console.error(this.formatMessage('ERROR', ...args));
  }

  warn(...args: any[]): void {
    console.warn(this.formatMessage('WARN', ...args));
  }

  debug(...args: any[]): void {
    console.debug(this.formatMessage('DEBUG', ...args));
  }
}

export default Logger;