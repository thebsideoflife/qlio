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

/** Present only while an IQ agent run owns this project's cut. */
export interface AgentRunStatus {
  runId: string;
  status: string;
  stage: string;
  startedAt?: string;
}

export interface ProjectJobStatus {
  projectId: string;
  generationJob: JobStatus | null;
  framingJob: JobStatus | null;
  exportMetadataJob: JobStatus | null;
  exportPackageJob?: JobStatus | null;
  activeRenderJobId: string | null;
  /** Absent on older deployments, so treat undefined as "no agent running". */
  agentRun?: AgentRunStatus | null;
  /** Backend render fingerprint version; differs when this tab is out of date. */
  renderPipelineVersion?: number;
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
  activeLanguage?: string;
}

export const updateProject = async (
  projectId: string,
  data: {
    title?: string;
    segments?: Segment[];
    captionSettings?: CaptionSettings;
    globalFraming?: GlobalFramingSettings;
    metadata?: {
      userPrompt?: string | null;
      purpose?: string | null;
      format?: string | null;
      assetType?: string | null;
      platform?: string | null;
      minSegmentDuration?: number | null;
      maxSegmentDuration?: number | null;
      targetPercent?: number | null;
    };
  },
) => {
  const response = await axios.patch(`${API_URL}/projects/${projectId}`, data, {
    headers: getAuthHeaders(),
  });
  return response.data;
};

export const translateProjectCaptions = async (
  projectId: string,
  targetLanguage: string,
): Promise<{
  language: string;
  sourceLanguage: string;
  status: "pending" | "ready";
  cached?: boolean;
  alreadyPending?: boolean;
  translationUrl?: string | null;
  transcriptionVersion?: string;
}> => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/captions/translate`,
    { targetLanguage },
    { headers: getAuthHeaders(), timeout: 15_000 },
  );
  return response.data;
};

export const waitForCaptionTranslation = async (
  assetId: string,
  targetLanguage: string,
  timeoutMs = 16 * 60_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const asset = await getAsset(assetId);
      const url = asset.translations?.[targetLanguage];
      if (typeof url === "string" && url.startsWith("http")) return url;

      const status = asset.translationStatuses?.[targetLanguage];
      if (status === "failed") {
        throw new Error(
          asset.translationErrors?.[targetLanguage] || "Translation failed",
        );
      }
    } catch (err) {
      if (!axios.isAxiosError(err)) throw err;
      const status = err.response?.status;
      if (status && status < 500 && status !== 429) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error("Translation is still running. Try again shortly.");
};

export const retryAssetTranscription = async (
  assetId: string,
): Promise<{ assetId: string; transcriptionStatus: string }> => {
  const response = await axios.post(
    `${API_URL}/assets/${assetId}/transcribe`,
    {},
    { headers: getAuthHeaders() },
  );
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
    iab?: {
      cattax: 7;
      cat: string[];
      labels?: string[];
    };
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
    includeIab?: boolean;
    iabFields?: {
      formFactor?: boolean;
      genres?: boolean;
      /** Content-aboutness categories. Written by the IQ agent, not requested here. */
      topics?: boolean;
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

// Render the exact editor snapshot. Autosave can still be in flight when the
// producer starts an export, so the project record is only a legacy fallback.
export interface RenderRequest {
  outputFormat?: "mp4" | "webm";
  quality?: "draft" | "standard" | "high";
  segmentIds?: string[]; // Optional: render only specific segments (by ID)
  captionSettings?: CaptionSettings;
  segments?: Segment[];
  globalFraming?: GlobalFramingSettings;
  /** Render even if a matching render is already stored. */
  force?: boolean;
}

export interface SegmentDownload {
  segmentId: string;
  title: string;
  status: "rendering" | "completed" | "failed";
  downloadUrl?: string;
  progress?: number;
  error?: string;
  contentHash?: string;
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

export interface ExportPackageResponse {
  status: "pending" | "packaging" | "completed" | "failed";
  jobId: string;
  filename?: string;
  downloadUrl?: string;
  error?: string;
  warnings?: string[];
  startedAt?: string;
  completedAt?: string;
}

export const startExportPackage = async (
  projectId: string,
  body: {
    segmentIds: string[];
    includeThumbnails?: boolean;
    includePoster?: boolean;
    projectTitle?: string;
    metadataDocument?: unknown;
  },
): Promise<ExportPackageResponse> => {
  const response = await axios.post(
    `${API_URL}/projects/${projectId}/export-package`,
    body,
    { headers: getAuthHeaders() },
  );
  return response.data;
};

export const getExportPackage = async (
  projectId: string,
): Promise<ExportPackageResponse> => {
  const response = await axios.get(
    `${API_URL}/projects/${projectId}/export-package`,
    { headers: getAuthHeaders() },
  );
  return response.data;
};

export const pollExportPackage = async (
  projectId: string,
  options: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<ExportPackageResponse> => {
  const { signal, pollIntervalMs = 4000, maxWaitMs = 900_000 } = options;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    signal?.throwIfAborted();
    const job = await getExportPackage(projectId);
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error("Timed out waiting for the download folder");
};

export const startRender = async (
  projectId: string,
  request: RenderRequest,
): Promise<{
  jobId: string;
  status: string;
  message?: string;
  reusedCount?: number;
  renderPipelineVersion?: number;
}> => {
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
