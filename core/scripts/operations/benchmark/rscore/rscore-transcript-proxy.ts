#!/usr/bin/env bun

/** Capture exact framed rscore requests and replies while transparently proxying them. */

import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';

const TRANSCRIPT_MAGIC = Buffer.from('XRSCTR01');
const MAX_FRAME_BYTES = 1_000 * 1024 * 1024;

const requiredEnv = (name: string): string => {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`RSCORE_TRANSCRIPT_ENV_REQUIRED:${name}`);
  return value;
};

class FrameCollector {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.#buffer = this.#buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.#buffer, chunk]);
    const frames: Buffer[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) {
        throw new Error(`RSCORE_TRANSCRIPT_FRAME_LENGTH:${length}`);
      }
      if (this.#buffer.length < length + 4) break;
      frames.push(Buffer.from(this.#buffer.subarray(4, length + 4)));
      this.#buffer = this.#buffer.subarray(length + 4);
    }
    return frames;
  }

  finish(label: string): void {
    if (this.#buffer.length !== 0) {
      throw new Error(`RSCORE_TRANSCRIPT_PARTIAL_${label}:${this.#buffer.length}`);
    }
  }
}

const target = requiredEnv('XLN_RSCORE_CAPTURE_TARGET');
const transcript = requiredEnv('XLN_RSCORE_CAPTURE_PATH')
  .replace('%PID%', String(process.pid));
const descriptor = openSync(transcript, 'wx', 0o600);
writeSync(descriptor, TRANSCRIPT_MAGIC);

const child = spawn(target, [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
const requests = new FrameCollector();
const responses = new FrameCollector();
let requestCount = 0;
let responseCount = 0;
let failed: Error | null = null;

const writeRecord = (direction: 0 | 1, frame: Buffer): void => {
  const header = Buffer.alloc(5);
  header[0] = direction;
  header.writeUInt32BE(frame.length, 1);
  writeSync(descriptor, header);
  writeSync(descriptor, frame);
};

const fail = (cause: unknown): void => {
  if (failed !== null) return;
  failed = cause instanceof Error ? cause : new Error(String(cause));
  console.error(failed.message);
  child.kill('SIGKILL');
};

process.stdin.on('data', (chunk: Buffer) => {
  try {
    for (const frame of requests.push(chunk)) {
      writeRecord(0, frame);
      requestCount += 1;
    }
    if (!child.stdin.write(chunk)) {
      process.stdin.pause();
      child.stdin.once('drain', () => process.stdin.resume());
    }
  } catch (cause) {
    fail(cause);
  }
});
process.stdin.on('end', () => child.stdin.end());
process.stdin.on('error', fail);

child.stdout.on('data', (chunk: Buffer) => {
  try {
    for (const frame of responses.push(chunk)) {
      writeRecord(1, frame);
      responseCount += 1;
    }
    if (!process.stdout.write(chunk)) {
      child.stdout.pause();
      process.stdout.once('drain', () => child.stdout.resume());
    }
  } catch (cause) {
    fail(cause);
  }
});
child.stderr.pipe(process.stderr);
child.on('error', fail);

child.on('close', (code, signal) => {
  try {
    requests.finish('REQUEST');
    responses.finish('RESPONSE');
    if (failed === null && requestCount !== responseCount) {
      throw new Error(`RSCORE_TRANSCRIPT_PAIR_COUNT:${requestCount}:${responseCount}`);
    }
  } catch (cause) {
    fail(cause);
  } finally {
    closeSync(descriptor);
  }
  if (failed !== null) process.exitCode = 1;
  else if (code !== 0) {
    console.error(`RSCORE_TRANSCRIPT_TARGET_EXIT:code=${String(code)}:signal=${String(signal)}`);
    process.exitCode = 1;
  }
});
