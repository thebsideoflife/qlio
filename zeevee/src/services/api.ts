import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "API_GATEWAY_URL";

export interface UploadUrlResponse {
  uploadUrl: string;
  assetId: string;
  key: string;
}

export const getUploadUrl = async (
  fileType: string
): Promise<UploadUrlResponse> => {
  let extension = fileType.split("/")[1] || "mp4";
  if (extension === "quicktime") extension = "mov";

  const response = await axios.get(`${API_URL}/upload`, {
    params: {
      contentType: fileType,
      extension,
    },
  });
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
    console.error("S3 Upload Failed:");
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error("Status:", error.response.status);
      console.error("XML Error:", error.response.data); // This XML says WHY (e.g. SignatureDoesNotMatch)
    } else if (error.request) {
      // The request was made but no response was received (CORS/Network error)
      console.error(
        "No response received (likely CORS or Network Error). Request:",
        error.request
      );
    } else {
      console.error("Error setup:", error.message);
    }
    throw error;
  }
};

export const listAssets = async () => {
  const response = await axios.get(`${API_URL}/assets`);
  return response.data;
};
