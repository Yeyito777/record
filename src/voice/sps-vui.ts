class AnnexBBitstreamReader {
  private byteOffset = 0;
  private bitOffset = 0;

  constructor(private readonly buffer: Buffer) {}

  readBits(count: number): number {
    if (count === 0) return 0;
    let result = 0;
    while (count > 0) {
      if (this.byteOffset >= this.buffer.length) throw new Error("Bad H264 SPS byte offset");
      if (this.bitOffset === 0 && this.byteOffset >= 2 && this.buffer[this.byteOffset - 2] === 0 && this.buffer[this.byteOffset - 1] === 0 && this.buffer[this.byteOffset] === 3) {
        this.byteOffset += 1;
      }
      if (this.bitOffset === 0 && count >= 8) {
        result = (result << 8) | this.buffer[this.byteOffset++];
        count -= 8;
      } else {
        const bitsToRead = Math.min(count, 8 - this.bitOffset);
        const mask = (1 << bitsToRead) - 1;
        const bits = (this.buffer[this.byteOffset] >> (8 - this.bitOffset - bitsToRead)) & mask;
        result = (result << bitsToRead) | bits;
        count -= bitsToRead;
        this.bitOffset += bitsToRead;
        if (this.bitOffset === 8) {
          this.bitOffset = 0;
          this.byteOffset += 1;
        }
      }
    }
    return result;
  }

  readUnsigned(bits: number): number { return this.readBits(bits); }

  readUnsignedExpGolomb(): number {
    let leadingZeroes = 0;
    while (this.readBits(1) === 0) leadingZeroes += 1;
    return (1 << leadingZeroes) + this.readBits(leadingZeroes) - 1;
  }

  readSignedExpGolomb(): number {
    const value = this.readUnsignedExpGolomb();
    return value % 2 === 0 ? value / -2 : (value + 1) / 2;
  }
}

class AnnexBBitstreamWriter {
  private readonly bytes: number[] = [];
  private pendingByte = 0;
  private bitOffset = 0;

  toBuffer(): Buffer { return Buffer.from(this.bytes); }

  flush(): void {
    if (this.pendingByte <= 3 && this.bytes.at(-1) === 0 && this.bytes.at(-2) === 0) this.bytes.push(3);
    this.bytes.push(this.pendingByte);
    this.pendingByte = 0;
    this.bitOffset = 0;
  }

  writeBits(bits: number, count: number): void {
    while (count > 0) {
      if (this.bitOffset === 0) {
        if (count >= 8) {
          this.pendingByte = (bits >> (count - 8)) & 0xff;
          count -= 8;
          this.flush();
        } else {
          const mask = (1 << count) - 1;
          this.pendingByte |= (bits & mask) << (8 - count);
          this.bitOffset = count;
          count = 0;
        }
      } else {
        const bitsToWrite = Math.min(8 - this.bitOffset, count);
        const value = (bits >> (count - bitsToWrite)) & ((1 << bitsToWrite) - 1);
        this.pendingByte |= value << (8 - this.bitOffset - bitsToWrite);
        count -= bitsToWrite;
        this.bitOffset += bitsToWrite;
        if (this.bitOffset === 8) {
          this.bitOffset = 0;
          this.flush();
        }
      }
    }
  }

  writeUnsigned(value: number, count: number): void {
    if (value < 0) throw new Error("Expected a non-negative value");
    this.writeBits(value, count);
  }

  writeUnsignedExpGolomb(value: number): void {
    if (value < 0) throw new Error("Expected a non-negative value");
    value += 1;
    const bitCount = 32 - Math.clz32(value >>> 0);
    this.writeBits(0, bitCount - 1);
    this.writeBits(value, bitCount);
  }

  writeSignedExpGolomb(value: number): void {
    this.writeUnsignedExpGolomb(value < 0 ? -2 * value : 2 * value - 1);
  }
}

export function rewriteH264SpsVuiForWebRtc(buffer: Buffer): Buffer {
  const reader = new AnnexBBitstreamReader(buffer.subarray(1));
  const writer = new AnnexBBitstreamWriter();

  const readBit = (n = 1) => reader.readBits(n);
  const writeBit = (v: number, n = 1) => writer.writeBits(v, n);
  const readU = (n: number) => reader.readUnsigned(n);
  const writeU = (v: number, n: number) => writer.writeUnsigned(v, n);
  const readUE = () => reader.readUnsignedExpGolomb();
  const writeUE = (v: number) => writer.writeUnsignedExpGolomb(v);
  const readSE = () => reader.readSignedExpGolomb();
  const writeSE = (v: number) => writer.writeSignedExpGolomb(v);

  writeU(buffer[0], 8);
  const profileIdc = readU(8); writeU(profileIdc, 8);
  const constraintFlags = readU(8); writeU(constraintFlags, 8);
  const levelIdc = readU(8); writeU(levelIdc, 8);
  writeUE(readUE());

  const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 144]);
  if (highProfiles.has(profileIdc)) {
    const chromaFormatIdc = readUE(); writeUE(chromaFormatIdc);
    if (chromaFormatIdc === 3) writeBit(readBit(1), 1);
    writeUE(readUE());
    writeUE(readUE());
    writeBit(readBit(1), 1);
    const scalingMatrix = readBit(1); writeBit(scalingMatrix, 1);
    if (scalingMatrix) {
      const scalingCount = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < scalingCount; i += 1) {
        const present = readBit(1); writeBit(present, 1);
        if (present) {
          const size = i < 6 ? 16 : 64;
          for (let j = 0; j < size; j += 1) writeSE(readSE());
        }
      }
    }
  }

  writeUE(readUE());
  const picOrderCntType = readUE(); writeUE(picOrderCntType);
  if (picOrderCntType === 0) {
    writeUE(readUE());
  } else if (picOrderCntType === 1) {
    writeBit(readBit(1), 1);
    writeSE(readSE());
    writeSE(readSE());
    const cycle = readUE(); writeUE(cycle);
    for (let i = 0; i < cycle; i += 1) writeSE(readSE());
  }

  const maxNumRefFrames = readUE(); writeUE(maxNumRefFrames);
  writeBit(readBit(1), 1);
  writeUE(readUE());
  writeUE(readUE());
  const frameMbsOnly = readBit(1); writeBit(frameMbsOnly, 1);
  if (frameMbsOnly === 0) writeBit(readBit(1), 1);
  writeBit(readBit(1), 1);
  const cropping = readBit(1); writeBit(cropping, 1);
  if (cropping) {
    writeUE(readUE()); writeUE(readUE()); writeUE(readUE()); writeUE(readUE());
  }

  function addBitstreamRestriction(): void {
    writeBit(1, 1);
    writeUE(2);
    writeUE(1);
    writeUE(16);
    writeUE(16);
    writeUE(0);
    writeUE(maxNumRefFrames);
  }

  const vuiPresent = readBit(1);
  writeBit(1, 1);
  if (!vuiPresent) {
    writeBit(0, 2);
    writeBit(0, 1);
    writeBit(0, 5);
    writeBit(1, 1);
    addBitstreamRestriction();
  } else {
    const aspect = readBit(1); writeBit(aspect, 1);
    if (aspect) {
      const aspectIdc = readU(8); writeU(aspectIdc, 8);
      if (aspectIdc === 255) { writeU(readU(16), 16); writeU(readU(16), 16); }
    }
    const overscan = readBit(1); writeBit(overscan, 1);
    if (overscan) writeBit(readBit(1), 1);
    const videoSignal = readBit(1); writeBit(0, 1);
    if (videoSignal) {
      readBit(3);
      readBit(1);
      const colour = readBit(1);
      if (colour) { readU(8); readU(8); readU(8); }
    }
    const chroma = readBit(1); writeBit(chroma, 1);
    if (chroma) { writeUE(readUE()); writeUE(readUE()); }
    const timing = readBit(1); writeBit(timing, 1);
    if (timing) { writeU(readU(32), 32); writeU(readU(32), 32); writeBit(readBit(1), 1); }
    const nalHrd = readBit(1); writeBit(nalHrd, 1);
    if (nalHrd) copyHrdParameters(readBit, writeBit, readUE, writeUE);
    const vclHrd = readBit(1); writeBit(vclHrd, 1);
    if (vclHrd) copyHrdParameters(readBit, writeBit, readUE, writeUE);
    if (nalHrd || vclHrd) writeBit(readBit(1), 1);
    writeBit(readBit(1), 1);
    const restriction = readBit(1); writeBit(1, 1);
    if (!restriction) {
      addBitstreamRestriction();
    } else {
      writeBit(readBit(1), 1);
      writeUE(readUE());
      writeUE(readUE());
      writeUE(readUE());
      writeUE(readUE());
      readUE(); writeUE(0);
      readUE(); writeUE(maxNumRefFrames);
    }
  }
  writeBit(1, 1);
  writer.flush();
  return writer.toBuffer();
}

function copyHrdParameters(
  readBit: (count?: number) => number,
  writeBit: (value: number, count?: number) => void,
  readUE: () => number,
  writeUE: (value: number) => void,
): void {
  const cpbCount = readUE(); writeUE(cpbCount);
  writeBit(readBit(4), 4);
  writeBit(readBit(4), 4);
  for (let i = 0; i <= cpbCount; i += 1) {
    writeUE(readUE());
    writeUE(readUE());
    writeBit(readBit(1), 1);
  }
  writeBit(readBit(5), 5);
  writeBit(readBit(5), 5);
  writeBit(readBit(5), 5);
  writeBit(readBit(5), 5);
}
