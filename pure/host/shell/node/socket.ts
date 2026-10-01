// A TCP connection as lines of text: the one place the shell touches a socket. A record of the link is one line, so a
// line is the unit; the bytes after a newline wait for the next read, and a peer that sends more than `max` bytes
// without a newline is cut off, because the link bounds what it reads before it believes any of it (R-X1).
//
// Nothing here keeps state a caller can see: a read takes the text left over from the one before and gives back what
// is left over after it, so the caller's loop holds it. A connection that cannot be made, a write that fails and a
// peer that goes away are values (`SocketFault`, an ended read), never thrown.
import { on, once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { err, ok, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";

export type SocketFault = Tagged<"socket", { reason: string }>;

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const fault = (cause: unknown): SocketFault => ({ _tag: "socket", reason: reasonOf(cause) });

/** What a read gives: the next line, and what is left of the text received so far. */
export type Line = Readonly<{ line: string; rest: string }>;

export type Wire = Readonly<{
  /** The next line, or nothing when the peer closed the connection or a line grew past the bound. */
  next: (rest: string) => Promise<Line | undefined>;
  write: (line: string) => Promise<Result<void, SocketFault>>;
  close: () => void;
}>;

const NEWLINE = "\n";
const NO_LINE: Line | undefined = undefined;

const lineFrom = (
  chunks: AsyncIterator<readonly unknown[]>, max: number, rest: string,
): Promise<Line | undefined> => {
  const cut = rest.indexOf(NEWLINE);
  if (cut > max || (cut < 0 && rest.length > max)) return Promise.resolve(NO_LINE);
  if (cut >= 0) return Promise.resolve({ line: rest.slice(0, cut), rest: rest.slice(cut + 1) });
  return chunks.next().then((got) => (got.done ? undefined : lineFrom(chunks, max, rest + String(got.value[0]))));
};

const ENDS = ["end", "close", "error"];

const wireOf = (socket: Socket, max: number): Wire => {
  socket.setEncoding("utf8");
  const chunks = on(socket, "data", { close: ENDS })[Symbol.asyncIterator]();
  return {
    next: (rest) => lineFrom(chunks, max, rest),
    write: (line) => new Promise((resolve) => {
      socket.write(`${line}${NEWLINE}`, (cause) =>
        resolve(cause === null || cause === undefined ? ok(undefined) : err(fault(cause))));
    }),
    close: () => { socket.destroy(); },
  };
};

/** A connection to `host:port`, or why there is none. */
export const dialTcp = (host: string, port: number, max: number): Promise<Result<Wire, SocketFault>> => {
  const socket = connect({ host, port });
  return once(socket, "connect").then(
    (): Result<Wire, SocketFault> => ok(wireOf(socket, max)),
    (cause): Result<Wire, SocketFault> => { socket.destroy(); return err(fault(cause)); },
  );
};

/** A port that is listening: the connections peers open to it, one at a time, until it is closed. */
export type Listener = Readonly<{
  port: number;
  accept: () => Promise<Wire | undefined>;
  close: () => void;
}>;

export const listenTcp = (host: string, port: number, max: number): Promise<Result<Listener, SocketFault>> => {
  const server = createServer();
  const arrivals = on(server, "connection", { close: ["close", "error"] })[Symbol.asyncIterator]();
  server.listen({ host, port });
  return once(server, "listening").then(
    (): Result<Listener, SocketFault> => {
      const bound = server.address();
      return typeof bound === "object" && bound !== null
        ? ok({
          port: bound.port,
          accept: () => arrivals.next().then((got) => (got.done ? undefined : wireOf(got.value[0] as Socket, max))),
          close: () => { server.close(); },
        })
        : err(fault("the server has no address"));
    },
    (cause): Result<Listener, SocketFault> => err(fault(cause)),
  );
};
