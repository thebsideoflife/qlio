import { createReadStream, promises as fs } from "fs";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/** Upload a local clip with retryable, buffered S3 parts. */
export async function uploadClipToS3(
  s3Client: S3Client,
  localPath: string,
  bucket: string,
  key: string,
): Promise<void> {
  const { size } = await fs.stat(localPath);
  const readStream = createReadStream(localPath);

  try {
    await new Upload({
      client: s3Client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: readStream,
        ContentType: "video/mp4",
      },
    }).done();
  } catch (error) {
    // S3 can commit an upload and still return InternalError. A job-specific
    // key with the expected byte count is already the clip we need.
    try {
      const object = await s3Client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (object.ContentLength === size) {
        console.warn(`S3 reported an upload error after storing s3://${bucket}/${key}`);
        return;
      }
    } catch {
      // Preserve the upload error when S3 is unavailable or the object is absent.
    }
    throw error;
  } finally {
    readStream.destroy();
  }

  console.log(`Uploaded ${size} bytes to s3://${bucket}/${key}`);
}
