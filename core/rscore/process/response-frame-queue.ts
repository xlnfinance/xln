/** Rust transport's absolute response-frame ceiling. */
const RSCORE_MAX_RESPONSE_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Bytes retained before one response is isolated. The extra four bytes are
 * the length prefix; anything beyond one framed response is unsolicited.
 */
const RSCORE_MAX_BUFFERED_RESPONSE_BYTES = RSCORE_MAX_RESPONSE_FRAME_BYTES + 4;

type FrameQueueLimits = Readonly<{
  maxFrameBytes: number;
  maxBufferedBytes: number;
}>;

const DEFAULT_LIMITS: FrameQueueLimits = {
  maxFrameBytes: RSCORE_MAX_RESPONSE_FRAME_BYTES,
  maxBufferedBytes: RSCORE_MAX_BUFFERED_RESPONSE_BYTES,
};

/**
 * Bounded, single-response parser for the process stdout stream.
 *
 * Chunks form a head-index deque. Consuming N fragments advances an integer;
 * it never shifts the remaining N-1 array entries and never recopies bytes
 * already received. A fragmented frame is copied exactly once into its final
 * isolated Buffer.
 */
export class RscoreResponseFrameQueue {
  #chunks: Buffer[] = [];
  #head = 0;
  #chunkOffset = 0;
  #bufferedBytes = 0;
  #expectedFrameBytes: number | null = null;
  readonly #limits: FrameQueueLimits;

  constructor(limits: FrameQueueLimits = DEFAULT_LIMITS) {
    if (
      !Number.isSafeInteger(limits.maxFrameBytes) ||
      limits.maxFrameBytes <= 0 ||
      limits.maxFrameBytes > 0xffff_ffff
    ) {
      throw new Error(`RSCORE_CLIENT_FRAME_LIMIT_INVALID:${limits.maxFrameBytes}`);
    }
    if (
      !Number.isSafeInteger(limits.maxBufferedBytes) ||
      limits.maxBufferedBytes < 4 ||
      limits.maxBufferedBytes > limits.maxFrameBytes + 4
    ) {
      throw new Error(`RSCORE_CLIENT_BUFFER_LIMIT_INVALID:${limits.maxBufferedBytes}`);
    }
    this.#limits = limits;
  }

  reset(): void {
    this.#chunks = [];
    this.#head = 0;
    this.#chunkOffset = 0;
    this.#bufferedBytes = 0;
    this.#expectedFrameBytes = null;
  }

  /** Append bytes and return the sole complete response, or null if partial. */
  push(chunk: Buffer): Buffer | null {
    if (chunk.length === 0) return null;
    const nextBufferedBytes = this.#bufferedBytes + chunk.length;
    if (nextBufferedBytes > this.#limits.maxBufferedBytes) {
      throw new Error(
        `RSCORE_CLIENT_BUFFER_LIMIT:${nextBufferedBytes}:${this.#limits.maxBufferedBytes}`,
      );
    }
    this.#chunks.push(chunk);
    this.#bufferedBytes = nextBufferedBytes;

    if (this.#expectedFrameBytes === null) {
      if (this.#bufferedBytes < 4) return null;
      const header = this.#takeBytes(4, false);
      const length = header.readUInt32BE(0);
      if (length === 0 || length > this.#limits.maxFrameBytes) {
        throw new Error(`RSCORE_CLIENT_FRAME_LENGTH:${length}`);
      }
      this.#expectedFrameBytes = length;
    }
    if (this.#bufferedBytes < this.#expectedFrameBytes) return null;

    const frame = this.#takeBytes(this.#expectedFrameBytes, true);
    this.#expectedFrameBytes = null;
    if (this.#bufferedBytes !== 0) {
      throw new Error('RSCORE_CLIENT_UNEXPECTED_FRAME');
    }
    return frame;
  }

  /** Consume exactly `length` bytes without recopying prior chunks. */
  #takeBytes(length: number, isolate: boolean): Buffer {
    if (length > this.#bufferedBytes) throw new Error('RSCORE_CLIENT_BUFFER_UNDERFLOW');
    const first = this.#chunks[this.#head];
    if (!first) throw new Error('RSCORE_CLIENT_BUFFER_EMPTY');
    const available = first.length - this.#chunkOffset;
    if (available >= length) {
      const view = first.subarray(this.#chunkOffset, this.#chunkOffset + length);
      this.#chunkOffset += length;
      this.#bufferedBytes -= length;
      if (this.#chunkOffset === first.length) this.#releaseHead();
      return isolate ? Buffer.from(view) : view;
    }

    const output = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const next = this.#chunks[this.#head];
      if (!next) throw new Error('RSCORE_CLIENT_BUFFER_TRUNCATED');
      const take = Math.min(length - written, next.length - this.#chunkOffset);
      next.copy(output, written, this.#chunkOffset, this.#chunkOffset + take);
      written += take;
      this.#chunkOffset += take;
      this.#bufferedBytes -= take;
      if (this.#chunkOffset === next.length) this.#releaseHead();
    }
    return output;
  }

  #releaseHead(): void {
    this.#head += 1;
    this.#chunkOffset = 0;
    if (this.#head === this.#chunks.length) {
      this.#chunks = [];
      this.#head = 0;
    }
  }
}
