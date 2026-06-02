"use client";

import type React from "react";
import { useState, type ChangeEvent } from "react";
import { Eye, EyeOff, Mail, Lock, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { auth, db, googleProvider } from "./firebaseConfig"; // Match the path from signup
import {
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { SparklesCore } from "@/ui/sparkles";
import axios from "axios";
import { setAccessToken } from "../services/apiClient";

const Login: React.FC = () => {
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const navigate = useNavigate();

  const handleLogin = async () => {
    if (!email || !password) {
      setError("Please fill in all fields");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      console.log("TRACE: starting handleLogin for email:", email);
      const userCredential = await signInWithEmailAndPassword(
        auth,
        email,
        password
      );
      const user = userCredential.user;
      console.log("TRACE 1: Firebase User Object (Email Login):", JSON.stringify({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerified
      }, null, 2));

      console.log("TRACE: retrieving Firebase ID Token...");
      const firebaseToken = await user.getIdToken();
      console.log("TRACE 2: Firebase ID token retrieval status: SUCCESS. Token length:", firebaseToken ? firebaseToken.length : 0);
      
      const payload = {};
      const headers = { Authorization: `Bearer ${firebaseToken}` };
      console.log("TRACE 3: Session endpoint request payload:", JSON.stringify(payload), "Headers keys:", Object.keys(headers));

      console.log("TRACE: sending POST to /api/auth/session...");
      const response = await axios.post("/api/auth/session", payload, { headers });
      console.log("TRACE 4: Session endpoint response status:", response.status, "data:", JSON.stringify(response.data, null, 2));
      
      const { accessToken } = response.data;
      console.log("TRACE: setting access token. Length:", accessToken ? accessToken.length : 0);
      setAccessToken(accessToken);
      
      console.log("TRACE 7: Redirecting to /chat");
      navigate("/chat");
    } catch (err: any) {
      console.error("TRACE 8: Exact stack trace / exception in handleLogin:", err);
      if (err.response) {
        console.error("TRACE 8: Response error details status:", err.response.status, "data:", JSON.stringify(err.response.data));
      }
      const errorCode = err?.code || "";
      setError(getErrorMessage(errorCode) || err.message || "Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    setError("");

    try {
      console.log("TRACE: starting handleGoogleLogin via signInWithPopup...");
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;
      console.log("TRACE 1: Firebase User Object (Google Login):", JSON.stringify({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL
      }, null, 2));

      console.log("TRACE: retrieving Firebase ID Token...");
      const firebaseToken = await user.getIdToken();
      console.log("TRACE 2: Firebase ID token retrieval status: SUCCESS. Token length:", firebaseToken ? firebaseToken.length : 0);

      const payload = {};
      const headers = { Authorization: `Bearer ${firebaseToken}` };
      console.log("TRACE 3: Session endpoint request payload:", JSON.stringify(payload), "Headers keys:", Object.keys(headers));

      console.log("TRACE: sending POST to /api/auth/session...");
      const response = await axios.post("/api/auth/session", payload, { headers });
      console.log("TRACE 4: Session endpoint response status:", response.status, "data:", JSON.stringify(response.data, null, 2));
      
      const { accessToken } = response.data;
      console.log("TRACE: setting access token. Length:", accessToken ? accessToken.length : 0);
      setAccessToken(accessToken);

      console.log("TRACE: checking if user exists in Firestore...");
      const userDoc = doc(db, "users", user.uid);
      const userSnapshot = await getDoc(userDoc);

      if (!userSnapshot.exists()) {
        console.log("TRACE: User doc does not exist in Firestore. Creating doc for uid:", user.uid);
        await setDoc(userDoc, {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          role: "student", // default role
          createdAt: new Date().toISOString(),
          isPro: false,
          topicRequestsUsed: 0,
          maxTopicRequests: 10,
          photoURL: user.photoURL,
        });
        console.log("TRACE: User doc created in Firestore successfully.");
      } else {
        console.log("TRACE: User doc already exists in Firestore.");
      }

      console.log("TRACE 7: Redirecting to /chat");
      navigate("/chat");
    } catch (err: any) {
      console.error("TRACE 8: Exact stack trace / exception in handleGoogleLogin:", err);
      if (err.response) {
        console.error("TRACE 8: Response error details status:", err.response.status, "data:", JSON.stringify(err.response.data));
      }
      const errorCode = err?.code || "";
      setError(getErrorMessage(errorCode) || err.message || "Google Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  const getErrorMessage = (errorCode: string): string => {
    switch (errorCode) {
      case "auth/user-not-found":
        return "No account found with this email address.";
      case "auth/wrong-password":
        return "Incorrect password. Please try again.";
      case "auth/invalid-email":
        return "Please enter a valid email address.";
      case "auth/user-disabled":
        return "This account has been disabled.";
      case "auth/too-many-requests":
        return "Too many failed attempts. Please try again later.";
      case "auth/network-request-failed":
        return "Network error. Please check your connection.";
      case "auth/popup-closed-by-user":
        return "Sign-in was cancelled.";
      case "auth/cancelled-popup-request":
        return "Only one popup request is allowed at a time.";
      default:
        return "Login failed. Please try again.";
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleLogin();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-black">
      {/* Sparkles Background */}
      <div className="absolute inset-0 w-full h-full">
        <SparklesCore
          id="login-sparkles"
          background="transparent"
          minSize={0.4}
          maxSize={1.2}
          particleDensity={80}
          className="w-full h-full"
          particleColor="#FFFFFF"
        />
      </div>

      <div className="relative w-full max-w-md z-10">
        {/* Modular Black Login Card */}
        <div className="absolute inset-0 bg-black/90 backdrop-blur-sm rounded-3xl shadow-2xl border border-[#232323]" />
        <div className="relative p-8 z-10">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">
              Welcome to Lerno AI
            </h1>
            <p className="text-gray-400">Your AI companion for learning</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Email field */}
            <div className="relative">
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 z-10 pointer-events-none" />
                <input
                  type="email"
                  value={email}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setEmail(e.target.value)
                  }
                  className="w-full pl-12 pr-4 py-4 bg-[#191919]/80 backdrop-blur-sm border border-[#333333] rounded-2xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:border-gray-600 transition-all duration-300 relative z-0"
                  placeholder="Enter your email"
                  required
                />
              </div>
            </div>

            {/* Password field */}
            <div className="relative">
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 z-10 pointer-events-none" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setPassword(e.target.value)
                  }
                  className="w-full pl-12 pr-12 py-4 bg-[#191919]/80 backdrop-blur-sm border border-[#333333] rounded-2xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:border-gray-600 transition-all duration-300 relative z-0"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white transition-colors z-10 cursor-pointer"
                >
                  {showPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm backdrop-blur-sm">
                {error}
              </div>
            )}

            {/* Login button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-[#191919]/80 backdrop-blur-sm text-white font-semibold rounded-2xl py-3 mt-2 cursor-pointer hover:bg-[#232323]/80 transition disabled:opacity-50"
            >
              {isLoading ? (
                <div className="flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></div>
                  Signing in...
                </div>
              ) : (
                <div className="flex items-center justify-center space-x-2">
                  <span>Sign In</span>
                  <ArrowRight className="w-5 h-5" />
                </div>
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[#232323]"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-black/90 text-gray-400">
                or continue with
              </span>
            </div>
          </div>

          {/* Google login */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={isLoading}
            className="w-full flex items-center justify-center space-x-3 py-4 px-6 bg-[#191919]/80 backdrop-blur-sm border-none rounded-2xl text-white hover:bg-[#232323]/80 transition-all duration-300 cursor-pointer disabled:opacity-50"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="#FFFFFF"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#FFFFFF"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FFFFFF"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#FFFFFF"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>

          {/* Sign up link */}
          <div className="text-center mt-8 text-gray-400">
            <p>
              {"Don't have an account? "}
              <button
                onClick={() => navigate("/signup")}
                className="text-gray-300 hover:text-white transition-colors cursor-pointer underline font-semibold"
              >
                Sign up now
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
