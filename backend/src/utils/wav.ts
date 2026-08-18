/**
 * PCM WAV header reader. Used to get an exact sample count after FFmpeg
 * writes 16 kHz mono PCM — duration floats from the container are not used.
 */

export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  samplesPerChannel: number;
  durationSec: number;
};

export type PcmAudioLevel = {
  peakAmplitude: number;
  rmsAmplitude: number;
};

/**
 * Treat only near-digital-silence as silence. The peak threshold is -50 dBFS
 * and the RMS threshold is -60 dBFS, so quiet speech still fails closed.
 */
export function isEffectivelySilent(level: PcmAudioLevel): boolean {
  return level.peakAmplitude <= 0.0032 && level.rmsAmplitude <= 0.001;
}

function readFourCC(buf: Buffer, offset: number): string {
  return buf.toString("ascii", offset, offset + 4);
}

function readU32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readU16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

/**
 * Parse a RIFF/WAVE header (and any extra chunks) from the start of a file.
 * `buf` only needs to include bytes through the start of the `data` chunk.
 */
export function parseWavInfo(buf: Buffer): WavInfo {
  if (buf.length < 12) throw new Error("WAV header too short");
  if (readFourCC(buf, 0) !== "RIFF" || readFourCC(buf, 8) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  while (offset + 8 <= buf.length) {
    const id = readFourCC(buf, offset);
    const size = readU32(buf, offset + 4);
    const payload = offset + 8;
    if (id === "fmt ") {
      if (payload + 16 > buf.length) break;
      channels = readU16(buf, payload + 2);
      sampleRate = readU32(buf, payload + 4);
      bitsPerSample = readU16(buf, payload + 14);
    } else if (id === "data") {
      dataOffset = payload;
      dataBytes = size;
      break;
    }
    // Chunks are word-aligned
    offset = payload + size + (size % 2);
  }

  if (!sampleRate || !channels || !bitsPerSample) {
    throw new Error("WAV fmt chunk missing or incomplete");
  }
  if (dataOffset < 0) {
    throw new Error("WAV data chunk not found in header buffer");
  }

  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error(`Unsupported bitsPerSample ${bitsPerSample}`);
  }
  const frameBytes = bytesPerSample * channels;
  const samplesPerChannel = Math.floor(dataBytes / frameBytes);
  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset,
    dataBytes,
    samplesPerChannel,
    durationSec: samplesPerChannel / sampleRate,
  };
}

/** Minimal PCM WAV for tests (16-bit, little-endian). */
export function encodePcmWav(params: {
  samples: Int16Array;
  sampleRate: number;
  channels?: number;
}): Buffer {
  const channels = params.channels ?? 1;
  const dataBytes = params.samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(params.sampleRate, 24);
  buf.writeUInt32LE(params.sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(params.samples.buffer, params.samples.byteOffset, dataBytes).copy(
    buf,
    44,
  );
  return buf;
}
