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
  },
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
  metadata: Record<string, unknown>,
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
    },
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

  await upload.done();
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

export const updateAsset = async (
  assetId: string,
  metadata: Record<string, unknown>,
) => {
  const response = await axios.patch(`${API_URL}/assets/${assetId}`, metadata, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const createProject = async (
  assetId: string,
  metadata: Record<string, unknown>,
) => {
  const response = await axios.post(
    `${API_URL}/projects`,
    {
      assetId,
      metadata,
    },
    {
      headers: getAuthHeaders(),
    },
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

export interface CaptionSettings {
  enabled: boolean;
  style: {
    fontSize: number;
    fontFamily: string;
    color: string;
    backgroundColor: string;
    position: { x: number; y: number };
    maxWidth: number;
    highlightColor?: string;
  };
}

export const updateProject = async (
  projectId: string,
  data: {
    title?: string;
    segments?: Segment[];
    captionSettings?: CaptionSettings;
    globalFraming?: GlobalFramingSettings;
  },
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

// ===== Segment Generation API (Async) =====

export interface GenerationJob {
  status:
    | "pending"
    | "detecting_scenes"
    | "generating"
    | "completed"
    | "failed";
  jobId: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  segmentCount?: number;
}

export interface GenerateSegmentsResponse {
  message: string;
  jobId: string;
  status: "pending";
}

export const generateSegments = async (
  projectId: string,
  metadata: Record<string, unknown>,
): Promise<GenerateSegmentsResponse> => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/generate`,
    { metadata },
    {
      headers: getAuthHeaders(),
    },
  );
  return response.data;
};

/**
 * Poll for generation job completion.
 * Returns the project data when job is complete or throws on failure.
 *
 * Default timing:
 * - 30s initial delay (generation takes at least 30s)
 * - 10s poll interval thereafter
 * - 5 min max wait
 */
export const pollGenerationStatus = async (
  projectId: string,
  options: {
    onProgress?: (status: GenerationJob) => void;
    initialDelayMs?: number;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<{ segments: Segment[]; job: GenerationJob }> => {
  const {
    onProgress,
    initialDelayMs = 30000, // Wait 30s before first poll
    pollIntervalMs = 10000, // Poll every 10s
    maxWaitMs = 600000, // 10 min max (matches Lambda timeout)
  } = options;
  const startTime = Date.now();

  // Initial delay - generation takes at least 30 seconds
  await new Promise((resolve) => setTimeout(resolve, initialDelayMs));

  while (Date.now() - startTime < maxWaitMs) {
    const project = await getProject(projectId);
    const job: GenerationJob | undefined = project.generationJob;

    if (!job) {
      throw new Error("No generation job found for this project");
    }

    onProgress?.(job);

    if (job.status === "completed") {
      return { segments: project.segments || [], job };
    }

    if (job.status === "failed") {
      throw new Error(job.error || "Generation failed");
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Generation timed out");
};

export const deleteAsset = async (assetId: string) => {
  const response = await axios.delete(`${API_URL}/assets/${assetId}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

// ===== Render API =====

// Framing types (used for sync, not render requests)
export type AspectRatio = "9:16" | "1:1" | "16:9";
export type FramingMode = "crop" | "fit";

export interface SegmentFraming {
  aspectRatio: AspectRatio;
  mode: FramingMode;
  focusX: number;
  focusY: number;
  aiReasoning?: string;
  isAiGenerated: boolean;
}

export interface GlobalFramingSettings {
  aspectRatio: AspectRatio;
  enabled: boolean;
}

// Render request is minimal - all project data is read from DB by backend
// This follows best practice: backend is source of truth
export interface RenderRequest {
  outputFormat?: "mp4" | "webm";
  quality?: "draft" | "standard" | "high";
  segmentIds?: string[]; // Optional: render only specific segments (by ID)
}

export interface SegmentDownload {
  segmentId: string;
  title: string;
  status: "rendering" | "completed" | "failed";
  downloadUrl?: string;
  progress?: number;
  error?: string;
}

export interface RenderJobResponse {
  jobId: string;
  status: "pending" | "cutting" | "rendering" | "completed" | "failed";
  progress: number;
  segmentCount?: number;
  completedCount?: number;
  segmentDownloads?: SegmentDownload[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  // Legacy single-video fields (deprecated)
  downloadUrl?: string;
  outputS3Uri?: string;
}

export const startRender = async (
  projectId: string,
  request: RenderRequest,
): Promise<{ jobId: string; status: string; message?: string }> => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/render`,
    request,
    {
      headers: getAuthHeaders(),
    },
  );
  return response.data;
};

export const getRenderStatus = async (
  jobId: string,
): Promise<RenderJobResponse> => {
  const response = await axios.get(`${API_URL}/renders/${jobId}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

// ===== Framing Analysis API =====

export interface FramingAnalysisResult {
  mode: "crop" | "fit";
  focusX: number;
  focusY: number;
  aiReasoning: string;
  isAiGenerated: boolean;
}

export interface AnalyzeFramingKeyframe {
  id: string;
  time: number;
  focusX: number;
  focusY: number;
  zoom: number;
  aiReasoning?: string;
  isAiGenerated: boolean;
}

export interface AnalyzeFramingResponse {
  segmentId: string | null;
  startTime: number;
  endTime: number;
  framing: FramingAnalysisResult;
  keyframes?: AnalyzeFramingKeyframe[];
}

/**
 * Analyze a video segment to determine optimal framing for the target aspect ratio.
 * Uses 12labs Pegasus to decide whether to crop (focus on subject) or fit (show full scene).
 *
 * @param projectId - The project ID
 * @param segmentId - Optional segment ID for the API route
 * @param startTime - Segment start time in seconds
 * @param endTime - Segment end time in seconds
 * @param targetAspectRatio - The target output aspect ratio ("16:9", "1:1", or "9:16")
 */
export const analyzeSegmentFraming = async (
  projectId: string,
  segmentId: string | null,
  startTime: number,
  endTime: number,
  targetAspectRatio: "16:9" | "1:1" | "9:16" = "9:16",
): Promise<AnalyzeFramingResponse> => {
  const url = segmentId
    ? `${API_URL}/projects/${projectId}/segments/${segmentId}/analyze-framing`
    : `${API_URL}/projects/${projectId}/analyze-framing`;

  const response = await axios.post(
    url,
    { startTime, endTime, targetAspectRatio },
    {
      headers: getAuthHeaders(),
    },
  );
  return response.data;
};

/**
 * Start batch framing analysis for all segments (async — returns immediately).
 * Poll getProject() for framingJob status; results written to segments in DB.
 */
export interface BatchFramingSegment {
  id: string;
  startTime: number;
  endTime: number;
}

export interface StartBatchFramingResponse {
  message: string;
  jobId: string;
  status: "pending";
}

export interface FramingJob {
  status: "pending" | "analyzing" | "completed" | "failed";
  jobId: string;
  startedAt: string;
  completedAt?: string;
  segmentCount?: number;
  completedCount?: number;
  error?: string;
}

export const startBatchFraming = async (
  projectId: string,
  segments: BatchFramingSegment[],
  targetAspectRatio: "16:9" | "1:1" | "9:16" = "9:16",
): Promise<StartBatchFramingResponse> => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/analyze-framing`,
    { segments, targetAspectRatio },
    { headers: getAuthHeaders() },
  );
  return response.data;
};
