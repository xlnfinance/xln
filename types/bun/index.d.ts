namespace Bun {
  interface BunFile extends Blob {
    readonly name?: string;
    readonly size: number;
    readonly type: string;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  type ServeWebSocket<T = unknown> = {
    data: T;
    close(code?: number, reason?: string): void;
    send(data: string | Uint8Array | ArrayBuffer): number;
    subscribe(topic: string): void;
    unsubscribe(topic: string): void;
  };

  type Server = {
    port: number;
    hostname: string;
    stop(closeActiveConnections?: boolean): void | Promise<void>;
    upgrade<T = unknown>(request: Request, options?: { data?: T }): boolean;
    publish(topic: string, data: string | Uint8Array | ArrayBuffer): number;
  };

  type ServeOptions<T = unknown> = {
    port?: number;
    hostname?: string;
    idleTimeout?: number;
    tls?: {
      key?: BunFile | string;
      cert?: BunFile | string;
      [key: string]: unknown;
    };
    fetch(request: Request, server: Server): Response | Promise<Response>;
    websocket?: {
      open?(ws: ServeWebSocket<T>): void | Promise<void>;
      message?(ws: ServeWebSocket<T>, message: string | Uint8Array | ArrayBuffer): void | Promise<void>;
      close?(ws: ServeWebSocket<T>, code: number, reason: string): void | Promise<void>;
      drain?(ws: ServeWebSocket<T>): void | Promise<void>;
    };
  };

  function serve<T = unknown>(options: ServeOptions<T>): Server;
  function file(path: string | URL): BunFile;
}

declare module 'bun:sqlite' {
  export class Database {
    constructor(path?: string, options?: unknown);
    close(): void;
    exec(sql: string): void;
    query<T = unknown, Params extends unknown[] = unknown[]>(sql: string): {
      get(...params: Params): T | null;
      all(...params: Params): T[];
      run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
    };
    prepare<T = unknown, Params extends unknown[] = unknown[]>(sql: string): {
      get(...params: Params): T | null;
      all(...params: Params): T[];
      run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
    };
    transaction<T extends (...args: any[]) => any>(fn: T): T;
  }
}

declare module 'bun' {
  export type BunFile = Bun.BunFile;
  export type Server = Bun.Server;
  export type ServerWebSocket<T = unknown> = Bun.ServeWebSocket<T>;
  export type ServeOptions<T = unknown> = Bun.ServeOptions<T>;
  export const serve: typeof Bun.serve;
export const file: typeof Bun.file;
}
