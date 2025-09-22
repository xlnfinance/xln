/**
 * XLN Structured Logging System
 *
 * Replaces console.log with structured, leveled logging.
 * Sovereign logger - no external dependencies.
 */

export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  FATAL = 5,
  SILENT = 6
}

export interface LogContext {
  entityId?: string;
  signerId?: string;
  blockHeight?: number;
  transactionType?: string;
  channelId?: string;
  [key: string]: any;
}

class Logger {
  private level: LogLevel;
  private context: LogContext = {};

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = this.getLevelFromEnv() || level;
  }

  private getLevelFromEnv(): LogLevel | null {
    const envLevel = process.env.XLN_LOG_LEVEL;
    if (!envLevel) return null;

    const levels: Record<string, LogLevel> = {
      'TRACE': LogLevel.TRACE,
      'DEBUG': LogLevel.DEBUG,
      'INFO': LogLevel.INFO,
      'WARN': LogLevel.WARN,
      'ERROR': LogLevel.ERROR,
      'FATAL': LogLevel.FATAL,
      'SILENT': LogLevel.SILENT
    };

    return levels[envLevel.toUpperCase()] || null;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  clearContext(): void {
    this.context = {};
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const levelName = LogLevel[level];
    const mergedContext = { ...this.context, ...context };

    // Use emojis for visual clarity in development
    const levelEmoji = {
      [LogLevel.TRACE]: '🔍',
      [LogLevel.DEBUG]: '🐛',
      [LogLevel.INFO]: '💡',
      [LogLevel.WARN]: '⚠️',
      [LogLevel.ERROR]: '❌',
      [LogLevel.FATAL]: '💀',
      [LogLevel.SILENT]: '🤫'
    };

    if (process.env.NODE_ENV === 'production') {
      // Structured JSON for production
      return JSON.stringify({
        timestamp,
        level: levelName,
        message,
        ...mergedContext
      });
    } else {
      // Human-readable for development
      const emoji = levelEmoji[level] || '';
      const contextStr = Object.keys(mergedContext).length > 0
        ? ` [${Object.entries(mergedContext).map(([k, v]) => `${k}:${v}`).join(' ')}]`
        : '';
      return `${emoji} ${levelName}${contextStr}: ${message}`;
    }
  }

  trace(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.TRACE)) {
      console.log(this.formatMessage(LogLevel.TRACE, message, context));
    }
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage(LogLevel.DEBUG, message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage(LogLevel.INFO, message, context));
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(LogLevel.WARN, message, context));
    }
  }

  error(message: string, context?: LogContext, error?: Error): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const errorContext = error ? { ...context, error: error.message, stack: error.stack } : context;
      console.error(this.formatMessage(LogLevel.ERROR, message, errorContext));
    }
  }

  fatal(message: string, context?: LogContext, error?: Error): void {
    if (this.shouldLog(LogLevel.FATAL)) {
      const errorContext = error ? { ...context, error: error.message, stack: error.stack } : context;
      console.error(this.formatMessage(LogLevel.FATAL, message, errorContext));
    }
  }

  // Specialized loggers for XLN domains

  jMachine(message: string, context?: LogContext): void {
    this.info(message, { ...context, layer: 'J-MACHINE' });
  }

  eMachine(message: string, context?: LogContext): void {
    this.info(message, { ...context, layer: 'E-MACHINE' });
  }

  aMachine(message: string, context?: LogContext): void {
    this.info(message, { ...context, layer: 'A-MACHINE' });
  }

  consensus(message: string, context?: LogContext): void {
    this.debug(message, { ...context, domain: 'CONSENSUS' });
  }

  channel(message: string, context?: LogContext): void {
    this.debug(message, { ...context, domain: 'CHANNEL' });
  }

  orderbook(message: string, context?: LogContext): void {
    this.trace(message, { ...context, domain: 'ORDERBOOK' });
  }
}

// Export singleton logger
export const logger = new Logger();

// Export for testing or creating isolated loggers
export { Logger };