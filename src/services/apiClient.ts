import axios from "axios";

// Local in-memory store for JWT access token
let accessToken: string | null = localStorage.getItem("lerno_access_token");

export const setAccessToken = (token: string | null) => {
  accessToken = token;
  if (token) {
    localStorage.setItem("lerno_access_token", token);
  } else {
    localStorage.removeItem("lerno_access_token");
  }
};

export const getAccessToken = () => accessToken;

// Create axios instance pointing to Express gateway /api/ prefix
export const apiClient = axios.create({
  baseURL: "",
  timeout: 60000, // 60 seconds timeout
  headers: {
    "Content-Type": "application/json",
  },
});

// Request Interceptor: Inject JWT access token if present
apiClient.interceptors.request.use(
  (config) => {
    const token = getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Session refresh queue management
let isRefreshing = false;
let refreshSubscribers: ((token: string) => void)[] = [];

const subscribeTokenRefresh = (cb: (token: string) => void) => {
  refreshSubscribers.push(cb);
};

const onRefreshed = (token: string) => {
  refreshSubscribers.forEach((cb) => cb(token));
  refreshSubscribers = [];
};

// Response Interceptor: Capture 401 unauthorized errors, refresh token and retry
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { config, response } = error;
    const originalRequest = config;

    // Do not retry refresh calls themselves to avoid infinite loop
    if (config.url === "/api/auth/refresh") {
      return Promise.reject(error);
    }

    if (response && response.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve) => {
          subscribeTokenRefresh((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            resolve(apiClient(originalRequest));
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // Exchange refresh token cookie for new access token
        const refreshRes = await axios.post("/api/auth/refresh");
        const newAccessToken = refreshRes.data.accessToken;
        
        setAccessToken(newAccessToken);
        isRefreshing = false;
        onRefreshed(newAccessToken);

        // Update authorization header on the original request
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(originalRequest);
      } catch (refreshErr) {
        isRefreshing = false;
        setAccessToken(null);
        // Dispatch an event to alert frontend to redirect to login
        window.dispatchEvent(new Event("auth-session-expired"));
        return Promise.reject(refreshErr);
      }
    }
    return Promise.reject(error);
  }
);
