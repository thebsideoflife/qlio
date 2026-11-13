/**
 * Fingerprint parity tests — keep in sync with
 * zeevee/src/scripts/test-segment-metadata-fingerprint.ts
 */
import { computeSegmentMetadataFingerprint } from "../services/export-metadata";

const FIXTURES: Array<{
  name: string;
  startTime: number;
  endTime: number;
  expected: string;
}> = [
  {
    name: "standard bounds",
    startTime: 12.5,
    endTime: 45.0,
    expected: "3c1e0959",
  },
  {
    name: "zero start",
    startTime: 0,
    endTime: 30,
    expected: "8f050293",
  },
  {
    name: "long segment",
    startTime: 100,
    endTime: 120,
    expected: "1f1e8a42",
  },
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

for (const f of FIXTURES) {
  const actual = computeSegmentMetadataFingerprint(f.startTime, f.endTime);
  assert(
    actual === f.expected,
    `${f.name}: expected ${f.expected}, got ${actual}`,
  );
}

console.log(`OK: ${FIXTURES.length} fingerprint fixtures`);
