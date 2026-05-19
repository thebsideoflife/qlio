import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { UploadCredentialsResponse } from "@/services/api";

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

export const uploadToS3 = async (
  uploadInfo: UploadCredentialsResponse,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<void> => {
  const { bucket, key, region, credentials } = uploadInfo;

  const s3Client = new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    useAccelerateEndpoint: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: file,
      ContentType: file.type,
    },
    queueSize: 8,
    partSize: 64 * 1024 * 1024,
    leavePartsOnError: false,
  });

  upload.on("httpUploadProgress", (progress) => {
    if (onProgress && progress.loaded && progress.total) {
      onProgress({
        loaded: progress.loaded,
        total: progress.total,
        percentage: Math.round((progress.loaded / progress.total) * 100),
      });
    }
  });

  await upload.done();
};
