/**
 * Chunk timestamp mapping.
 *
 * Long sources are split into ~55-minute chunks with 30s of overlap before
 * indexing, and each chunk is a separate TwelveLabs video with its own local
 * timeline. Every tool speaks the source timeline; this module is the only
 * place that knows chunks exist.
 *
 * Pure — no I/O, fully unit-testable. This is the subtlest logic in the feature.
 */

import { pegasusIndexedVideoDurationSec, type ChunkInfo } from "../twelvelabs";
import type { ChunkFacts } from "./types";

export interface RangePiece {
  chunk: ChunkFacts;
  /** Chunk-local seconds, already clamped to what TwelveLabs will accept. */
  localStart: number;
  localEnd: number;
  /** The source-timeline range this piece actually represents. */
  sourceStart: number;
  sourceEnd: number;
  /** True when clamping shortened the requested range. */
  clamped: boolean;
}

/**
 * Build chunk facts from the asset record. A non-chunked asset yields one
 * pseudo-chunk covering the whole timeline, so callers never branch.
 */
export function buildChunkFacts(params: {
  isChunked: boolean;
  chunks?: ChunkInfo[];
  twelveLabsVideoId?: string;
  duration: number;
}): ChunkFacts[] {
  if (!params.isChunked) {
    if (!params.twelveLabsVideoId) return [];
    return [
      {
        chunkIndex: 0,
        videoId: params.twelveLabsVideoId,
        sourceStart: 0,
        sourceEnd: params.duration,
        // Same 0.05s trim the chunked path applies: TwelveLabs rejects an end
        // that lands past the indexed duration, and the stored duration is a
        // probe of the source rather than of what was indexed.
        indexedDuration: Math.max(0, params.duration - 0.05),
      },
    ];
  }

  const chunks = (params.chunks ?? []).filter((c) => !!c.videoId);
  return chunks
    .slice()
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((c) => {
      const sourceStart = c.actualStartOffset ?? c.startOffset;
      const span =
        c.actualDuration != null && c.actualDuration > 0
          ? c.actualDuration
          : c.duration > 0
            ? c.duration
            : Math.max(0, c.endOffset - sourceStart);
      return {
        chunkIndex: c.chunkIndex,
        videoId: c.videoId!,
        sourceStart,
        sourceEnd: sourceStart + span,
        indexedDuration: pegasusIndexedVideoDurationSec(c),
      };
    });
}

/** Chunk-local seconds → source-timeline seconds. */
export function toSourceTime(chunk: ChunkFacts, localTime: number): number {
  return chunk.sourceStart + localTime;
}

/** Source-timeline seconds → chunk-local seconds (may fall outside the chunk). */
export function toLocalTime(chunk: ChunkFacts, sourceTime: number): number {
  return sourceTime - chunk.sourceStart;
}

/** The chunk a source timestamp sits most comfortably inside, if any. */
export function chunkForTime(
  chunks: ChunkFacts[],
  sourceTime: number,
): ChunkFacts | undefined {
  const candidates = chunks.filter(
    (c) => sourceTime >= c.sourceStart && sourceTime <= c.sourceEnd,
  );
  if (candidates.length === 0) return undefined;
  // With overlapping chunks, prefer the one where the timestamp is furthest
  // from either edge — that is where the indexed video is most reliable.
  return candidates.reduce((best, c) =>
    edgeMargin(c, sourceTime) > edgeMargin(best, sourceTime) ? c : best,
  );
}

function edgeMargin(chunk: ChunkFacts, sourceTime: number): number {
  return Math.min(sourceTime - chunk.sourceStart, chunk.sourceEnd - sourceTime);
}

/**
 * Split a source-timeline range into the fewest chunk-local pieces that cover
 * it. A range that fits inside a single chunk always yields exactly one piece,
 * even when chunks overlap.
 */
export function planRange(
  chunks: ChunkFacts[],
  start: number,
  end: number,
): RangePiece[] {
  if (chunks.length === 0 || end <= start) return [];

  const ordered = [...chunks].sort((a, b) => a.sourceStart - b.sourceStart);

  const containing = ordered.filter(
    (c) => start >= c.sourceStart && end <= c.sourceEnd,
  );
  if (containing.length > 0) {
    const best = containing.reduce((a, c) =>
      rangeMargin(c, start, end) > rangeMargin(a, start, end) ? c : a,
    );
    return [makePiece(best, start, end)];
  }

  const pieces: RangePiece[] = [];
  let cursor = start;
  for (const chunk of ordered) {
    if (cursor >= end) break;
    if (chunk.sourceEnd <= cursor) continue;
    if (chunk.sourceStart >= end) break;
    const pieceStart = Math.max(cursor, chunk.sourceStart);
    const pieceEnd = Math.min(end, chunk.sourceEnd);
    if (pieceEnd - pieceStart <= 0.001) continue;
    pieces.push(makePiece(chunk, pieceStart, pieceEnd));
    cursor = pieceEnd;
  }
  return pieces;
}

function rangeMargin(chunk: ChunkFacts, start: number, end: number): number {
  return Math.min(start - chunk.sourceStart, chunk.sourceEnd - end);
}

function makePiece(chunk: ChunkFacts, start: number, end: number): RangePiece {
  const rawLocalStart = toLocalTime(chunk, start);
  const rawLocalEnd = toLocalTime(chunk, end);
  const localStart = clamp(rawLocalStart, 0, chunk.indexedDuration);
  const localEnd = clamp(rawLocalEnd, localStart, chunk.indexedDuration);
  const clamped =
    Math.abs(localStart - rawLocalStart) > 0.01 ||
    Math.abs(localEnd - rawLocalEnd) > 0.01;
  return {
    chunk,
    localStart,
    localEnd,
    sourceStart: toSourceTime(chunk, localStart),
    sourceEnd: toSourceTime(chunk, localEnd),
    clamped,
  };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Widen a piece to satisfy the TwelveLabs 4-second minimum clip length,
 * staying inside the chunk. Returns null when the chunk itself is too short.
 */
export function widenToMinimumClip(
  piece: RangePiece,
  minSeconds: number,
): RangePiece | null {
  const span = piece.localEnd - piece.localStart;
  // Only a widened piece is "clamped"; an untouched one must keep its flag so
  // the caller does not report a shifted window that never shifted.
  if (span >= minSeconds) return piece;
  if (piece.chunk.indexedDuration < minSeconds) return null;

  const deficit = minSeconds - span;
  let localStart = piece.localStart - deficit / 2;
  let localEnd = piece.localEnd + deficit / 2;

  if (localStart < 0) {
    localEnd += -localStart;
    localStart = 0;
  }
  if (localEnd > piece.chunk.indexedDuration) {
    localStart -= localEnd - piece.chunk.indexedDuration;
    localEnd = piece.chunk.indexedDuration;
  }
  localStart = Math.max(0, localStart);

  return {
    ...piece,
    localStart,
    localEnd,
    sourceStart: toSourceTime(piece.chunk, localStart),
    sourceEnd: toSourceTime(piece.chunk, localEnd),
    clamped: true,
  };
}
