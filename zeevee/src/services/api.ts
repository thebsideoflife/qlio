import axios from "axios";

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

// ============================================================================
// SLIM POLLING ENDPOINTS - Use these for efficient polling
// ============================================================================

/**
 * Slim asset status list for polling. Returns only id, status, title, createdAt.
 * NO presigned URLs - use getAsset() when you need full asset with video URL.
 */
export interface SlimAssetStatus {
  id: string;
  status: string;
  title: string;
  format: string;
  createdAt: string;
  updatedAt?: string;
}

export const listAssetStatuses = async (): Promise<SlimAssetStatus[]> => {
  const response = await axios.get(`${API_URL}/assets/status`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

/**
 * Slim job status for polling. Returns only job info, no segments/captions/etc.
 * Use getProject() when you need the full project after jobs complete.
 */
export interface JobStatus {
  status: string;
  jobId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  segmentCount?: number;
  segmentErrors?: Array<{ segmentId: string; error: string }>;
  segmentWarnings?: Array<{
    segmentId: string;
    code: string;
    message: string;
  }>;
}

export interface ProjectJobStatus {
  projectId: string;
  generationJob: JobStatus | null;
  framingJob: JobStatus | null;
  exportMetadataJob: JobStatus | null;
  activeRenderJobId: string | null;
}

export const getProjectJobStatus = async (
  projectId: string,
): Promise<ProjectJobStatus> => {
  const response = await axios.get(`${API_URL}/projects/${projectId}/job`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

// ============================================================================
// FULL ENDPOINTS - Use these for initial load or after job completion
// ============================================================================

/**
 * Full asset list with presigned URLs. Use listAssetStatuses() for polling.
 */
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
    fontWeight?: string;
    color: string;
    backgroundColor: string;
    position: { x: number; y: number };
    maxWidth: number;
    highlightColor?: string;
  };
  wordEdits?: Record<string, string>;
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

export interface ProjectSummary {
  projectId: string;
  assetId: string;
  title: string;
  createdAt: string;
  segmentCount: number;
  firstSegmentStartTime: number | null;
  thumbnailUrl?: string | null;
  thumbnailStale?: boolean;
}

export const listProjects = async (
  assetId?: string,
): Promise<ProjectSummary[]> => {
  const response = await axios.get(`${API_URL}/projects`, {
    params: assetId ? { assetId } : {},
    headers: getAuthHeaders(),
  });
  return response.data;
};

// ===== Export Metadata API =====

export type ExportDescriptionLength =
  | "short"
  | "two_sentences"
  | "paragraph";

export interface SegmentExportMetadata {
  segmentId: string;
  contentHash: string;
  title?: string;
  descriptions?: {
    short?: string;
    two_sentences?: string;
    paragraph?: string;
  };
  tags?: {
    content_advisory?: string;
    mood?: string;
    theme?: string;
    tone?: string;
  };
  thumbnailUrl?: string | null;
  generatedAt?: string;
}

export interface GenerateExportMetadataRequest {
  segmentIds?: string[];
  options?: {
    includeTitles?: boolean;
    includeDescriptions?: boolean;
    descriptionLengths?: ExportDescriptionLength[];
    descriptiveTags?: {
      contentAdvisory?: boolean;
      mood?: boolean;
      theme?: boolean;
      tone?: boolean;
    };
    includeThumbnails?: boolean;
  };
}

export interface GenerateExportMetadataResponse {
  segments: SegmentExportMetadata[];
  generated: string[];
  cached: string[];
  errors?: Array<{ segmentId: string; error: string }>;
  warnings?: Array<{ segmentId: string; code: string; message: string }>;
  projectThumbnailUrl?: string | null;
}

export interface StartEnsureThumbnailsResponse {
  message: string;
  status: "generating";
  pendingCount: number;
}

export interface CompletedEnsureThumbnailsResponse {
  projects: EnsuredProjectThumbnail[];
  status: "completed";
}

export interface EnsuredProjectThumbnail {
  projectId: string;
  thumbnailUrl: string | null;
  generated?: boolean;
  error?: string;
}

export const ensureAssetProjectThumbnails = async (
  assetId: string,
): Promise<
  CompletedEnsureThumbnailsResponse | StartEnsureThumbnailsResponse
> => {
  const response = await axios.post(
    `${API_URL}/assets/${assetId}/ensure-project-thumbnails`,
    {},
    { headers: getAuthHeaders() },
  );
  return response.data;
};

/** Poll listProjects until thumbnails are fresh or timeout. */
export const pollProjectThumbnailsReady = async (
  assetId: string,
  options: {
    pollIntervalMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<ProjectSummary[]> => {
  // Ensure-thumbnails Lambda timeout is 300s — wait slightly longer
  const { pollIntervalMs = 3000, maxWaitMs = 330_000 } = options;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const projects = await listProjects(assetId);
    const stillStale = projects.some(
      (p) => p.segmentCount > 0 && p.thumbnailStale,
    );
    if (!stillStale) return projects;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return listProjects(assetId);
};

export interface StartExportMetadataResponse {
  message: string;
  jobId: string;
  status: "pending" | "generating";
}

export const startExportMetadata = async (
  projectId: string,
  body: GenerateExportMetadataRequest,
): Promise<GenerateExportMetadataResponse | StartExportMetadataResponse> => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/export-metadata`,
    body,
    { headers: getAuthHeaders() },
  );
  return response.data;
};

export const pollExportMetadataStatus = async (
  projectId: string,
  options: {
    segmentIds?: string[];
    onProgress?: (status: JobStatus) => void;
    initialDelayMs?: number;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<GenerateExportMetadataResponse> => {
  const {
    segmentIds,
    onProgress,
    initialDelayMs = 5000,
    pollIntervalMs = 5000,
    maxWaitMs = 900_000,
  } = options;
  const startTime = Date.now();

  await new Promise((resolve) => setTimeout(resolve, initialDelayMs));

  while (Date.now() - startTime < maxWaitMs) {
    const jobStatus = await getProjectJobStatus(projectId);
    const job = jobStatus.exportMetadataJob;

    if (!job) {
      throw new Error("No export metadata job found for this project");
    }

    onProgress?.(job);

    if (job.status === "completed") {
      const project = await getProject(projectId);
      let segments: SegmentExportMetadata[] = project.segmentMetadata || [];
      if (segmentIds?.length) {
        const ids = new Set(segmentIds);
        segments = segments.filter((s) => ids.has(s.segmentId));
      }
      return {
        segments,
        generated: [],
        cached: segments.map((s) => s.segmentId),
        errors: job.segmentErrors,
        warnings: job.segmentWarnings,
        projectThumbnailUrl: project.thumbnailUrl ?? null,
      };
    }

    if (job.status === "failed") {
      const err = new Error(job.error || "Export metadata generation failed");
      if (job.segmentErrors?.length) {
        (err as Error & { segmentErrors?: typeof job.segmentErrors }).segmentErrors =
          job.segmentErrors;
      }
      throw err;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Export metadata generation timed out");
};

/** Starts generation; polls automatically when the API returns 202. */
export const generateExportMetadata = async (
  projectId: string,
  body: GenerateExportMetadataRequest,
  options?: {
    onProgress?: (status: JobStatus) => void;
  },
): Promise<GenerateExportMetadataResponse> => {
  const response = await startExportMetadata(projectId, body);
  if ("segments" in response) {
    return response;
  }
  return pollExportMetadataStatus(projectId, {
    segmentIds: body.segmentIds,
    onProgress: options?.onProgress,
  });
};

// ===== Segment Generation API (Async) =====

export interface GenerationJob {
  status:
    | "pending"
    | "generating"
    | "framing"
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

export type GenerationPurpose = "compact_video" | "highlights" | "full_video" | "episode_recap";

export interface GenerateSegmentsRequest {
  userPrompt?: string;
  videoDuration?: number;
  autoFrame?: boolean;
  targetAspectRatio?: string;
  purpose?: GenerationPurpose;
  /** `null` or omit = Auto. Otherwise 25 / 50 / 75 (% of source). Ignored for sports (replays). */
  targetPercent?: number | null;
  /** Min per-segment length in seconds (default varies by format) */
  minSegmentDuration?: number;
  /** Max per-segment length in seconds (default varies by format) */
  maxSegmentDuration?: number;
  /** Pass-through metadata: tv | movie | other */
  assetType?: string;
  /** Pass-through metadata: mobile | tv | tiktok | ig | shorts | facebook */
  platform?: string;
  /** Pass-through metadata: compact_video | full_video | highlights | trailer | episode_recap | season_recap */
  format?: string;
  /** Use Jockey pipeline for compact/recap when backend env flags allow */
  jockeyEnabled?: boolean;
}

export const generateSegments = async (
  projectId: string,
  request: GenerateSegmentsRequest = {},
): Promise<GenerateSegmentsResponse> => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/generate`,
    {
      userPrompt: request.userPrompt,
      videoDuration: request.videoDuration,
      autoFrame: request.autoFrame ?? false,
      targetAspectRatio: request.targetAspectRatio ?? "9:16",
      purpose: request.purpose ?? "highlights",
      targetPercent: request.targetPercent,
      minSegmentDuration: request.minSegmentDuration,
      maxSegmentDuration: request.maxSegmentDuration,
      assetType: request.assetType,
      platform: request.platform,
      format: request.format,
      jockeyEnabled: request.jockeyEnabled === true,
    },
    {
      headers: getAuthHeaders(),
    },
  );
  return response.data;
};

/**
 * Poll for generation job completion using slim job status endpoint.
 * Only fetches full project when job completes (to get segments).
 *
 * Default timing:
 * - 30s initial delay (generation takes at least 30s)
 * - 10s poll interval thereafter
 * - 10 min max wait
 */
export const pollGenerationStatus = async (
  projectId: string,
  options: {
    onProgress?: (status: GenerationJob) => void;
    initialDelayMs?: number;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<{ segments: Segment[]; job: GenerationJob; title?: string }> => {
  const {
    onProgress,
    initialDelayMs = 30000, // Wait 30s before first poll
    pollIntervalMs = 10000, // Poll every 10s
    maxWaitMs = 900000, // 15 min max (long videos can take 10+ min)
  } = options;
  const startTime = Date.now();

  // Initial delay - generation takes at least 30 seconds
  await new Promise((resolve) => setTimeout(resolve, initialDelayMs));

  while (Date.now() - startTime < maxWaitMs) {
    // Use slim endpoint for polling - much lighter than full project
    const jobStatus = await getProjectJobStatus(projectId);
    const job = jobStatus.generationJob;

    if (!job) {
      throw new Error("No generation job found for this project");
    }

    // Convert slim job status to GenerationJob format
    const generationJob: GenerationJob = {
      status: job.status as GenerationJob["status"],
      jobId: job.jobId || "",
      startedAt: job.startedAt || "",
      completedAt: job.completedAt,
      error: job.error,
      segmentCount: job.segmentCount,
    };

    onProgress?.(generationJob);

    if (job.status === "completed") {
      // Only fetch full project when complete - need the segments
      const project = await getProject(projectId);
      return {
        segments: project.segments || [],
        job: generationJob,
        title: project.title,
      };
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
  // Square-top portrait mode (mirrors @/remotion/types). Only honored when enabled.
  squareTop?: boolean;
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

/**
 * Start async framing analysis for a single segment.
 * Poll getProjectJobStatus() for framingJob; results are written to segments in DB.
 */
export const startSegmentFraming = async (
  projectId: string,
  segmentId: string,
  startTime: number,
  endTime: number,
  targetAspectRatio: "16:9" | "1:1" | "9:16" = "9:16",
): Promise<StartBatchFramingResponse> => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/segments/${segmentId}/analyze-framing`,
    { startTime, endTime, targetAspectRatio },
    { headers: getAuthHeaders() },
  );
  return response.data;
};
