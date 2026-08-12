const H264_START_CODE = Buffer.from([0, 0, 0, 1]);
const H264_NAL_TYPE_STAP_A = 24;
const H264_NAL_TYPE_FU_A = 28;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FRAME_PACKETS = 4_096;
const DEFAULT_MAX_BUFFERED_FRAMES = 12;

export interface H264RtpFragment {
  sequence: number;
  timestamp: number;
  marker: boolean;
  payload: Buffer;
}

/**
 * Reassembles one RFC 6184 H.264 access unit at a time. DAVE protects a whole
 * encoded frame, so video must pass through this before DAVE decryption.
 */
export class H264RtpDepacketizer {
  private timestamp: number | null = null;
  private expectedSequence: number | null = null;
  private frame: Buffer[] = [];
  private frameBytes = 0;
  private packetCount = 0;
  private fragmentOpen = false;

  constructor(
    private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    private readonly maxFramePackets = DEFAULT_MAX_FRAME_PACKETS,
  ) {}

  push(fragment: H264RtpFragment): Buffer | null {
    if (this.timestamp !== fragment.timestamp || (this.expectedSequence !== null && this.expectedSequence !== fragment.sequence)) {
      this.reset(fragment.timestamp);
    }
    if (this.packetCount >= this.maxFramePackets) {
      this.reset(fragment.timestamp);
      return null;
    }
    this.packetCount += 1;
    this.expectedSequence = (fragment.sequence + 1) & 0xffff;

    const nalType = fragment.payload[0] === undefined ? 0 : fragment.payload[0] & 0x1f;
    const accepted = nalType >= 1 && nalType <= 23
      ? this.appendNal(fragment.payload)
      : nalType === H264_NAL_TYPE_STAP_A
        ? this.appendStapA(fragment.payload)
        : nalType === H264_NAL_TYPE_FU_A
          ? this.appendFuA(fragment.payload)
          : false;
    if (!accepted) {
      this.reset(fragment.timestamp);
      return null;
    }
    if (!fragment.marker) return null;
    if (this.fragmentOpen || this.frameBytes === 0) {
      this.reset(fragment.timestamp);
      return null;
    }

    const frame = Buffer.concat(this.frame, this.frameBytes);
    this.clear();
    return frame;
  }

  reset(timestamp: number | null = null): void {
    this.clear();
    this.timestamp = timestamp;
  }

  private clear(): void {
    this.timestamp = null;
    this.expectedSequence = null;
    this.frame = [];
    this.frameBytes = 0;
    this.packetCount = 0;
    this.fragmentOpen = false;
  }

  private appendNal(nal: Buffer): boolean {
    if (!this.reserve(H264_START_CODE.length + nal.length)) return false;
    this.frame.push(H264_START_CODE, nal);
    this.fragmentOpen = false;
    return true;
  }

  private appendStapA(payload: Buffer): boolean {
    const nalus: Buffer[] = [];
    let requiredBytes = 0;
    let offset = 1;
    while (offset + 2 <= payload.length) {
      const size = payload.readUInt16BE(offset);
      offset += 2;
      if (size === 0 || offset + size > payload.length) return false;
      const nal = payload.subarray(offset, offset + size);
      nalus.push(nal);
      requiredBytes += H264_START_CODE.length + nal.length;
      offset += size;
    }
    if (nalus.length === 0 || offset !== payload.length || !this.reserve(requiredBytes)) return false;
    for (const nal of nalus) this.frame.push(H264_START_CODE, nal);
    this.fragmentOpen = false;
    return true;
  }

  private appendFuA(payload: Buffer): boolean {
    if (payload.length < 3) return false;
    const indicator = payload[0]!;
    const fuHeader = payload[1]!;
    const start = (fuHeader & 0x80) !== 0;
    const end = (fuHeader & 0x40) !== 0;
    const fragment = payload.subarray(2);
    const prefixBytes = start ? H264_START_CODE.length + 1 : 0;
    if (!this.reserve(prefixBytes + fragment.length)) return false;
    if (start) {
      this.frame.push(H264_START_CODE, Buffer.from([(indicator & 0xe0) | (fuHeader & 0x1f)]));
      this.fragmentOpen = !end;
    } else if (!this.fragmentOpen) {
      return false;
    } else if (end) {
      this.fragmentOpen = false;
    }
    this.frame.push(fragment);
    return true;
  }

  private reserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.frameBytes + bytes > this.maxFrameBytes) return false;
    this.frameBytes += bytes;
    return true;
  }
}

interface BufferedH264Frame {
  firstSequence: number;
  markerSequence: number | null;
  packets: Map<number, Buffer>;
}

export interface CompleteH264RtpFrame {
  timestamp: number;
  frame: Buffer;
}

/**
 * Holds several RTP frames so late RTX repairs can fill sequence gaps before
 * DAVE decrypts the access unit. Discord routinely NACKs/retransmits packets
 * from large keyframes after packets from following frames have arrived.
 */
export class H264RtpJitterBuffer {
  private readonly frames = new Map<number, BufferedH264Frame>();
  private expectedFrameStart: number | null = null;

  constructor(
    private readonly maxBufferedFrames = DEFAULT_MAX_BUFFERED_FRAMES,
    private readonly maxFramePackets = DEFAULT_MAX_FRAME_PACKETS,
  ) {}

  push(fragment: H264RtpFragment): CompleteH264RtpFrame[] {
    let frame = this.frames.get(fragment.timestamp);
    if (!frame) {
      const expectedDistance = this.expectedFrameStart === null
        ? this.maxFramePackets + 1
        : (fragment.sequence - this.expectedFrameStart) & 0xffff;
      frame = {
        firstSequence: expectedDistance <= this.maxFramePackets ? this.expectedFrameStart! : fragment.sequence,
        markerSequence: null,
        packets: new Map(),
      };
      this.frames.set(fragment.timestamp, frame);
    } else {
      const earlierDistance = (frame.firstSequence - fragment.sequence) & 0xffff;
      if (earlierDistance > 0 && earlierDistance <= this.maxFramePackets) frame.firstSequence = fragment.sequence;
    }

    frame.packets.set(fragment.sequence, Buffer.from(fragment.payload));
    if (fragment.marker) {
      frame.markerSequence = fragment.sequence;
      this.expectedFrameStart = (fragment.sequence + 1) & 0xffff;
    }

    while (this.frames.size > this.maxBufferedFrames) {
      const oldestTimestamp = this.frames.keys().next().value;
      if (oldestTimestamp === undefined) break;
      this.frames.delete(oldestTimestamp);
    }
    return this.drainCompleteFrames();
  }

  reset(): void {
    this.frames.clear();
    this.expectedFrameStart = null;
  }

  private drainCompleteFrames(): CompleteH264RtpFrame[] {
    const complete: CompleteH264RtpFrame[] = [];
    for (const [timestamp, frame] of this.frames) {
      if (frame.markerSequence === null) continue;
      const packetCount = ((frame.markerSequence - frame.firstSequence) & 0xffff) + 1;
      if (packetCount < 1 || packetCount > this.maxFramePackets || frame.packets.size < packetCount) continue;
      const depacketizer = new H264RtpDepacketizer(undefined, this.maxFramePackets);
      let assembled: Buffer | null = null;
      let sequence = frame.firstSequence;
      for (let index = 0; index < packetCount; index += 1) {
        const payload = frame.packets.get(sequence);
        if (!payload) {
          assembled = null;
          break;
        }
        assembled = depacketizer.push({
          sequence,
          timestamp,
          marker: sequence === frame.markerSequence,
          payload,
        });
        sequence = (sequence + 1) & 0xffff;
      }
      if (!assembled) continue;
      this.frames.delete(timestamp);
      complete.push({ timestamp, frame: assembled });
    }
    return complete;
  }
}

export function packetizeH264AnnexB(frame: Buffer, maxPayloadBytes = 1_100): Buffer[] {
  if (maxPayloadBytes < 3) return [];
  const payloads: Buffer[] = [];
  for (const nal of splitAnnexBNalus(frame)) {
    if (nal.length <= maxPayloadBytes) {
      payloads.push(Buffer.from(nal));
      continue;
    }
    const nalHeader = nal[0];
    if (nalHeader === undefined) continue;
    const fuIndicator = (nalHeader & 0xe0) | H264_NAL_TYPE_FU_A;
    const fragmentCapacity = maxPayloadBytes - 2;
    for (let offset = 1; offset < nal.length; offset += fragmentCapacity) {
      const end = Math.min(nal.length, offset + fragmentCapacity);
      const fuHeader = (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | (nalHeader & 0x1f);
      payloads.push(Buffer.concat([Buffer.from([fuIndicator, fuHeader]), nal.subarray(offset, end)]));
    }
  }
  return payloads;
}

export function splitAnnexBNalus(frame: Buffer): Buffer[] {
  const starts: Array<{ index: number; length: number }> = [];
  for (let index = 0; index + 2 < frame.length;) {
    if (frame[index] === 0 && frame[index + 1] === 0 && frame[index + 2] === 1) {
      starts.push({ index, length: 3 });
      index += 3;
    } else if (index + 3 < frame.length && frame[index] === 0 && frame[index + 1] === 0 && frame[index + 2] === 0 && frame[index + 3] === 1) {
      starts.push({ index, length: 4 });
      index += 4;
    } else {
      index += 1;
    }
  }
  return starts.map((start, index) => frame.subarray(start.index + start.length, starts[index + 1]?.index ?? frame.length)).filter((nal) => nal.length > 0);
}
