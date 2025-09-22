/**
 * XLN Structured Logging System
 *
 * Replaces console.log with structured, leveled logging.
 * Sovereign logger - no external dependencies.
 */
export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["TRACE"] = 0] = "TRACE";
    LogLevel[LogLevel["DEBUG"] = 1] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 2] = "INFO";
    LogLevel[LogLevel["WARN"] = 3] = "WARN";
    LogLevel[LogLevel["ERROR"] = 4] = "ERROR";
    LogLevel[LogLevel["FATAL"] = 5] = "FATAL";
    LogLevel[LogLevel["SILENT"] = 6] = "SILENT";
})(LogLevel || (LogLevel = {}));
class Logger {
    level;
    context = {};
    constructor(level = LogLevel.INFO) {
        this.level = this.getLevelFromEnv() || level;
    }
    getLevelFromEnv() {
        const envLevel = process.env.XLN_LOG_LEVEL;
        if (!envLevel)
            return null;
        const levels = {
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
    setLevel(level) {
        this.level = level;
    }
    setContext(context) {
        this.context = { ...this.context, ...context };
    }
    clearContext() {
        this.context = {};
    }
    shouldLog(level) {
        return level >= this.level;
    }
    formatMessage(level, message, context) {
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
        }
        else {
            // Human-readable for development
            const emoji = levelEmoji[level] || '';
            const contextStr = Object.keys(mergedContext).length > 0
                ? ` [${Object.entries(mergedContext).map(([k, v]) => `${k}:${v}`).join(' ')}]`
                : '';
            return `${emoji} ${levelName}${contextStr}: ${message}`;
        }
    }
    trace(message, context) {
        if (this.shouldLog(LogLevel.TRACE)) {
            console.log(this.formatMessage(LogLevel.TRACE, message, context));
        }
    }
    debug(message, context) {
        if (this.shouldLog(LogLevel.DEBUG)) {
            console.log(this.formatMessage(LogLevel.DEBUG, message, context));
        }
    }
    info(message, context) {
        if (this.shouldLog(LogLevel.INFO)) {
            console.log(this.formatMessage(LogLevel.INFO, message, context));
        }
    }
    warn(message, context) {
        if (this.shouldLog(LogLevel.WARN)) {
            console.warn(this.formatMessage(LogLevel.WARN, message, context));
        }
    }
    error(message, context, error) {
        if (this.shouldLog(LogLevel.ERROR)) {
            const errorContext = error ? { ...context, error: error.message, stack: error.stack } : context;
            console.error(this.formatMessage(LogLevel.ERROR, message, errorContext));
        }
    }
    fatal(message, context, error) {
        if (this.shouldLog(LogLevel.FATAL)) {
            const errorContext = error ? { ...context, error: error.message, stack: error.stack } : context;
            console.error(this.formatMessage(LogLevel.FATAL, message, errorContext));
        }
    }
    // Specialized loggers for XLN domains
    jMachine(message, context) {
        this.info(message, { ...context, layer: 'J-MACHINE' });
    }
    eMachine(message, context) {
        this.info(message, { ...context, layer: 'E-MACHINE' });
    }
    aMachine(message, context) {
        this.info(message, { ...context, layer: 'A-MACHINE' });
    }
    consensus(message, context) {
        this.debug(message, { ...context, domain: 'CONSENSUS' });
    }
    channel(message, context) {
        this.debug(message, { ...context, domain: 'CHANNEL' });
    }
    orderbook(message, context) {
        this.trace(message, { ...context, domain: 'ORDERBOOK' });
    }
}
// Export singleton logger
export const logger = new Logger();
// Export for testing or creating isolated loggers
export { Logger };
