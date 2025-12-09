import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "API_GATEWAY_URL";

const getAuthHeaders = () => {
  const password = localStorage.getItem("api_password");
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

export interface UploadUrlResponse {
  uploadUrl: string;
  assetId: string;
  key: string;
}

export const getUploadUrl = async (
  fileType: string,
  metadata: any
): Promise<UploadUrlResponse> => {
  let extension = fileType.split("/")[1] || "mp4";
  if (extension === "quicktime") extension = "mov";

  // Changed to POST to support metadata body
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

export const uploadToS3 = async (uploadUrl: string, file: File) => {
  try {
    console.log(`Uploading ${file.name} (${file.type}) to S3...`);
    await axios.put(uploadUrl, file, {
      headers: {
        "Content-Type": file.type,
      },
    });
    console.log("Upload successful!");
  } catch (error: any) {
    console.error("S3 Upload Failed:", error);
    throw error;
  }
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

export const deleteAsset = async (assetId: string) => {
  const response = await axios.delete(`${API_URL}/assets/${assetId}`, {
    headers: getAuthHeaders(),
  });
  return response.data;
};
