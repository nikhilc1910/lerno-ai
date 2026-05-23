import { auth } from "../components/firebaseConfig";
import { toast } from "react-hot-toast";

export async function authFetch(url: string, options: RequestInit = {}) {
  const token = await auth.currentUser?.getIdToken();
  const headers = new Headers(options.headers);
  
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  
  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (res.status === 429) {
    const errorMsg = "Rate limit reached. Please wait a moment.";
    toast.error(errorMsg);
    throw new Error(errorMsg);
  }

  return res;
}
