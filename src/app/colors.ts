// colors.ts

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    underscore: "\x1b[4m",
    blink: "\x1b[5m",
    reverse: "\x1b[7m",
    hidden: "\x1b[8m",
  
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
  
    bgBlack: "\x1b[40m",
    bgRed: "\x1b[41m",
    bgGreen: "\x1b[42m",
    bgYellow: "\x1b[43m",
    bgBlue: "\x1b[44m",
    bgMagenta: "\x1b[45m",
    bgCyan: "\x1b[46m",
    bgWhite: "\x1b[47m"
  };
  
  export function colorize(color: keyof typeof colors, text: string): string {
    return `${colors[color]}${text}${colors.reset}`;
  }
  
  export const red = (text: string) => colorize('red', text);
  export const green = (text: string) => colorize('green', text);
  export const yellow = (text: string) => colorize('yellow', text);
  export const blue = (text: string) => colorize('blue', text);
  export const magenta = (text: string) => colorize('magenta', text);
  export const cyan = (text: string) => colorize('cyan', text);
  export const white = (text: string) => colorize('white', text);
  
  export default {
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    colorize
  };
  
  