import axios from "axios";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const API_URL = import.meta.env.VITE_API_URL;
const AUTH_KEY = "api_password";

if (!API_URL) {
  console.warn("VITE_API_URL is not defined");
}

const getAuthHeaders = () => {
  const password = localStorage.getItem(AUTH_KEY);
  return password ? { "x-api-password": password } : {};
};

// Add interceptor for 401s
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      // Redirect to signin page
      window.location.href = "/signin";
    }
    return Promise.reject(error);
  }
);

export interface UploadCredentialsResponse {
  assetId: string;
  key: string;
  bucket: string;
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: string;
  };
}

export const getUploadCredentials = async (
  fileType: string,
  metadata: any
): Promise<UploadCredentialsResponse> => {
  let extension = fileType.split("/")[1] || "mp4";
  if (extension === "quicktime") extension = "mov";

  const response = await axios.post(
    `${API_URL}/upload`,
    {
      contentType: fileType,
      extension,
      ...metadata,
    },
    {
      headers: getAuthHeaders(),
    }
  );
  return response.data;
};

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

export const uploadToS3 = async (
  uploadInfo: UploadCredentialsResponse,
  file: File,
  onProgress?: (progress: UploadProgress) => void
): Promise<void> => {
  const { bucket, key, region, credentials } = uploadInfo;

  const s3Client = new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    useAccelerateEndpoint: true, // Enable S3 Transfer Acceleration
    // Disable checksums to prevent "InvalidRequest: The upload was created using a crc32 checksum..." errors
    // S3 will still use standard ETag verification.
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
    // Multipart upload settings
    queueSize: 8, // Increase concurrency (browsers support more via HTTP/2)
    partSize: 64 * 1024 * 1024, // 64MB chunks (Better throughput for large files)
    leavePartsOnError: false, // Clean up on failure
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

  console.log(`Starting multipart upload for ${file.name} (${file.type})...`);
  await upload.done();
  console.log("Upload successful!");
};

export const listAssets = async () => {
  const response = await axios.get(`${API_URL}/assets`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const getAsset = async (assetId: string) => {
  const response = await axios.get(`${API_URL}/assets/${assetId}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const updateAsset = async (assetId: string, metadata: any) => {
  const response = await axios.patch(`${API_URL}/assets/${assetId}`, metadata, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const createProject = async (assetId: string, metadata: any) => {
  const response = await axios.post(
    `${API_URL}/projects`,
    {
      assetId,
      metadata,
    },
    {
      headers: getAuthHeaders(),
    }
  );
  return response.data;
};

export const getProject = async (projectId: string) => {
  const response = await axios.get(`${API_URL}/projects/${projectId}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
  description: string;
  characters: string[];
  sceneTags: string[];
  keyDialogue: string;
  confidence: number;
}

export const updateProject = async (
  projectId: string,
  data: { title?: string; segments?: Segment[] }
) => {
  const response = await axios.patch(`${API_URL}/projects/${projectId}`, data, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const deleteProject = async (projectId: string) => {
  const response = await axios.delete(`${API_URL}/projects/${projectId}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const listProjects = async (assetId?: string) => {
  const response = await axios.get(`${API_URL}/projects`, {
    params: assetId ? { assetId } : {},
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const generateSegments = async (projectId: string, metadata: any) => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/generate`,
    { metadata },
    {
      headers: getAuthHeaders(),
    }
  );
  return response.data;
};

export const deleteAsset = async (assetId: string) => {
  const response = await axios.delete(`${API_URL}/assets/${assetId}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};
