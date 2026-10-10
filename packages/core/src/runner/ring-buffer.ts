// A fixed-size byte buffer that keeps the newest bytes written to it, so a child's output flood costs bounded memory.

export class RingBuffer {
  private readonly buffer: Uint8Array;
  /** Where the next byte goes. */
  private end = 0;
  private total = 0;

  /** observe, a test seam, is handed the backing buffer (runner.ts's bufferProbe). */
  constructor(
    readonly capacity: number,
    observe?: (buffer: Uint8Array) => void,
  ) {
    this.buffer = new Uint8Array(capacity);
    observe?.(this.buffer);
  }

  push(chunk: Uint8Array): void {
    this.total += chunk.length;
    const { capacity } = this;
    const data = chunk.length > capacity ? chunk.subarray(chunk.length - capacity) : chunk;
    const first = Math.min(data.length, capacity - this.end);
    this.buffer.set(data.subarray(0, first), this.end);
    this.buffer.set(data.subarray(first), 0);
    this.end = (this.end + data.length) % capacity;
  }

  /** How many bytes were written but no longer fit. */
  get droppedBytes(): number {
    return Math.max(0, this.total - this.capacity);
  }

  /** Overwrites every kept byte with zeros and starts empty again (a sensitive run's end). */
  wipe(): void {
    this.buffer.fill(0);
    this.end = 0;
    this.total = 0;
  }

  /** The kept bytes, oldest first. */
  bytes(): Uint8Array {
    if (this.total < this.capacity) return this.buffer.slice(0, this.end);
    const out = new Uint8Array(this.capacity);
    out.set(this.buffer.subarray(this.end), 0);
    out.set(this.buffer.subarray(0, this.end), this.capacity - this.end);
    return out;
  }
}
