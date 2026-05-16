declare const Bun: {
  serve(options: {
    hostname?: string;
    port: number;
    fetch(req: Request): Response | Promise<Response>;
  }): {
    stop(force?: boolean): void;
  };
  file(path: string): Blob;
};

declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { create?: boolean; strict?: boolean });
    exec(sql: string): void;
    close(): void;
    query<T = unknown>(sql: string): {
      get(...params: unknown[]): T | null;
      all(...params: unknown[]): T[];
      run(...params: unknown[]): { changes: number };
    };
    transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
  }
}

interface ImportMeta {
  main?: boolean;
}
