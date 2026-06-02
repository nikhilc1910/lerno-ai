import { apiClient } from "../services/apiClient";
import { toast } from "react-hot-toast";

export async function authFetch(url: string, options: RequestInit = {}) {
  // Convert standard fetch options to axios config
  const method = (options.method || "GET").toUpperCase();
  const headers = options.headers ? Object.fromEntries(new Headers(options.headers).entries()) : {};
  const data = options.body ? (typeof options.body === "string" ? JSON.parse(options.body) : options.body) : options.body;

  try {
    const response = await apiClient({
      url,
      method,
      headers,
      data,
    });
    
    // Return a fetch-like Response object for compatibility
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.data,
      text: async () => typeof response.data === "object" ? JSON.stringify(response.data) : String(response.data),
    } as unknown as Response;
  } catch (error: any) {
    if (error.response) {
      if (error.response.status === 429) {
        const errorMsg = "Rate limit reached. Please wait a moment.";
        toast.error(errorMsg);
        throw new Error(errorMsg);
      }
      // Return response object even for error statuses so caller can inspect
      return {
        ok: false,
        status: error.response.status,
        json: async () => error.response.data,
        text: async () => typeof error.response.data === "object" ? JSON.stringify(error.response.data) : String(error.response.data),
      } as unknown as Response;
    }
    throw error;
  }
}
