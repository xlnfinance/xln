import { describe, expect, test } from 'bun:test';

import { RscoreResponseFrameQueue } from '../../rscore/response-frame-queue';

const frame = (body: Buffer): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

describe('rscore bounded response frame queue', () => {
  test('reassembles a response delivered as one-byte partial chunks', () => {
    const body = Buffer.alloc(64 * 1024, 0x5a);
    const reader = new RscoreResponseFrameQueue({
      maxFrameBytes: body.length,
      maxBufferedBytes: body.length + 4,
    });
    let result: Buffer | null = null;

    for (const byte of frame(body)) {
      const next = reader.push(Buffer.from([byte]));
      if (next !== null) result = next;
    }

    expect(result).toEqual(body);
  });

  test('rejects an absolute frame length above its cap before reading a body', () => {
    const reader = new RscoreResponseFrameQueue({
      maxFrameBytes: 16,
      maxBufferedBytes: 20,
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(17);

    expect(() => reader.push(header)).toThrow('RSCORE_CLIENT_FRAME_LENGTH:17');
  });

  test('rejects buffered working bytes above its cap', () => {
    const reader = new RscoreResponseFrameQueue({
      maxFrameBytes: 16,
      maxBufferedBytes: 8,
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(16);
    expect(reader.push(header)).toBeNull();
    expect(reader.push(Buffer.alloc(8))).toBeNull();

    expect(() => reader.push(Buffer.from([1]))).toThrow('RSCORE_CLIENT_BUFFER_LIMIT:9:8');
  });

  test('rejects one trailing byte and multiple complete frames', () => {
    const body = Buffer.from([1, 2, 3]);
    const one = frame(body);

    for (const bytes of [
      Buffer.concat([one, Buffer.from([0])]),
      Buffer.concat([one, one]),
    ]) {
      const reader = new RscoreResponseFrameQueue({
        maxFrameBytes: 16,
        maxBufferedBytes: 20,
      });
      expect(() => reader.push(bytes)).toThrow('RSCORE_CLIENT_UNEXPECTED_FRAME');
    }
  });
});
