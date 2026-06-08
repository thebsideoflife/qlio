import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { TranscriptSegment } from "../services/storyiq/types";

const s3Client = new S3Client({});

export async function fetchTranscriptFromS3(
  s3Uri: string,
): Promise<TranscriptSegment[]> {
  if (!s3Uri || !s3Uri.startsWith("s3://")) {
    throw new Error(`Invalid S3 URI: ${s3Uri}`);
  }

  const parts = s3Uri.replace("s3://", "").split("/");
  const bucket = parts[0];
  const key = parts.slice(1).join("/");

  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const bodyString = await response.Body?.transformToString();
  if (!bodyString) {
    throw new Error("Empty response from S3");
  }

  const data = JSON.parse(bodyString);
  return data.map((seg: Record<string, unknown>) => ({
    startTime: (seg.start ?? seg.startTime ?? 0) as number,
    endTime: (seg.end ?? seg.endTime ?? 0) as number,
    text: String(seg.text ?? seg.value ?? ""),
    speaker: typeof seg.speaker === "string" ? seg.speaker : undefined,
  }));
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatTranscriptLine(seg: TranscriptSegment): string {
  const speaker = seg.speaker ? `${seg.speaker}: ` : "";
  return `[${formatTimestamp(seg.startTime)}] ${speaker}${seg.text.trim()}`;
}

export function formatTranscriptLineNoTimestamp(seg: TranscriptSegment): string {
  const speaker = seg.speaker ? `${seg.speaker}: ` : "";
  return `${speaker}${seg.text.trim()}`;
}

export function transcriptInRangePlain(
  transcript: TranscriptSegment[],
  start: number,
  end: number,
): string {
  return transcript
    .filter((seg) => seg.endTime > start && seg.startTime < end)
    .map(formatTranscriptLineNoTimestamp)
    .join("\n");
}

export function transcriptInRange(
  transcript: TranscriptSegment[],
  start: number,
  end: number,
): string {
  return transcript
    .filter((seg) => seg.endTime > start && seg.startTime < end)
    .map(formatTranscriptLine)
    .join("\n");
}

function truncateTranscript(
  transcript: TranscriptSegment[],
  maxChars: number,
  formatter: (seg: TranscriptSegment) => string,
): string {
  const lines: string[] = [];
  let len = 0;
  for (const seg of transcript) {
    const line = formatter(seg);
    if (len + line.length + 1 > maxChars) {
      if (lines.length === 0) {
        lines.push(line.slice(0, maxChars - 3) + "...");
      } else {
        lines.push("…");
      }
      break;
    }
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join("\n");
}

export function truncateFullTranscript(
  transcript: TranscriptSegment[],
  maxChars: number,
): string {
  return truncateTranscript(transcript, maxChars, formatTranscriptLine);
}

export function truncateFullTranscriptPlain(
  transcript: TranscriptSegment[],
  maxChars: number,
): string {
  return truncateTranscript(transcript, maxChars, formatTranscriptLineNoTimestamp);
}
