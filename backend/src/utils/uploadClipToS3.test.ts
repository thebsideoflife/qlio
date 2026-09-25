import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import { uploadClipToS3 } from "./uploadClipToS3";

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function xml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "application/xml" });
  response.end(body);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clip-upload-test-"));
  const largeFile = path.join(dir, "large.mp4");
  const smallFile = path.join(dir, "small.mp4");
  const largeBytes = randomBytes(6 * 1024 * 1024);
  const smallBytes = randomBytes(1024);
  await Promise.all([
    writeFile(largeFile, largeBytes),
    writeFile(smallFile, smallBytes),
  ]);

  const parts = new Map<number, Buffer>();
  const objects = new Map<string, Buffer>();
  let firstPartAttempts = 0;
  let ambiguousPutAttempts = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const key = url.pathname;
      const body = await readBody(request);

      if (request.method === "POST" && url.searchParams.has("uploads")) {
        xml(response, 200, `<InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>large.mp4</Key><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>`);
      } else if (request.method === "PUT" && url.searchParams.has("partNumber")) {
        const number = Number(url.searchParams.get("partNumber"));
        if (number === 1 && ++firstPartAttempts === 1) {
          xml(response, 500, "<Error><Code>InternalError</Code><Message>Try again</Message></Error>");
        } else {
          parts.set(number, body);
          response.writeHead(200, { ETag: `"part-${number}"` });
          response.end();
        }
      } else if (request.method === "POST" && url.searchParams.has("uploadId")) {
        objects.set(key, Buffer.concat([...parts].sort(([a], [b]) => a - b).map(([, part]) => part)));
        xml(response, 200, `<CompleteMultipartUploadResult><Location>http://localhost${key}</Location><Bucket>test-bucket</Bucket><Key>large.mp4</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>`);
      } else if (request.method === "PUT") {
        if (key !== "/test-bucket/missing.mp4") objects.set(key, body);
        ambiguousPutAttempts += 1;
        xml(response, 500, "<Error><Code>InternalError</Code><Message>Try again</Message></Error>");
      } else if (request.method === "HEAD") {
        const object = objects.get(key);
        response.writeHead(object ? 200 : 404, object ? { "Content-Length": object.length } : {});
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new S3Client({
    region: "us-west-2",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true,
    maxAttempts: 2,
  });

  try {
    await uploadClipToS3(client, largeFile, "test-bucket", "large.mp4");
    assert.equal(firstPartAttempts, 2, "an S3 500 retries a buffered upload part");
    assert.deepEqual(objects.get("/test-bucket/large.mp4"), largeBytes);

    await uploadClipToS3(client, smallFile, "test-bucket", "small.mp4");
    assert.equal(ambiguousPutAttempts, 2, "the SDK exhausted retries for an ambiguous PUT");
    assert.deepEqual(objects.get("/test-bucket/small.mp4"), smallBytes);

    await assert.rejects(
      uploadClipToS3(client, smallFile, "test-bucket", "missing.mp4"),
      { name: "InternalError" },
      "an upload error still fails when S3 has no completed object",
    );
  } finally {
    client.destroy();
    server.close();
    await once(server, "close");
    await rm(dir, { recursive: true, force: true });
  }

  console.log("uploadClipToS3.test: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
