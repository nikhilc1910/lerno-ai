"use client";

import type React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { User, Mail, Lock, ArrowRight, Calendar } from "lucide-react";
import {
  createUserWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "./firebaseConfig"; // Adjust path as needed
import { SparklesCore } from "@/ui/sparkles";
import axios from "axios";
import { setAccessToken } from "../services/apiClient";

const SignUp: React.FC = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [parentConsent, setParentConsent] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [error, setError] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleDobChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setDob(value);
    if (value) {
      const today = new Date();
      const birthDate = new Date(value);
      let age = today.getFullYear() - birthDate.getFullYear();
      const m = today.getMonth() - birthDate.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
        age--;
      }
      setShowConsent(age < 13);
    } else {
      setShowConsent(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    if (!name || !email || !password || !dob) {
      setError("Please fill in all fields");
      setIsLoading(false);
      return;
    }

    // Calculate age for COPPA validation
    const today = new Date();
    const birthDate = new Date(dob);
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    if (age < 13 && !parentConsent) {
      setError("Under-13 accounts require verified parental consent to register. Please have a parent review and check the consent box.");
      setIsLoading(false);
      return;
    }

    try {
      console.log("TRACE: starting handleSignUp for email:", email);
      // Create user with Firebase Auth
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );
      const user = userCredential.user;
      console.log("TRACE 1: Firebase User Object (Email Signup):", JSON.stringify({
        uid: user.uid,
        email: user.email,
        displayName: name
      }, null, 2));

      console.log("TRACE: updating profile displayName...");
      // Update user profile with display name
      await updateProfile(user, {
        displayName: name,
      });

      console.log("TRACE: retrieving Firebase ID Token...");
      // Exchange Firebase Token for local custom JWT session
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

      console.log("TRACE: creating user profile document in Firestore...");
      // Store additional user data in Firestore
      await setDoc(doc(db, "users", user.uid), {
        uid: user.uid,
        email: email,
        displayName: name,
        createdAt: new Date().toISOString(),
        isPro: false,
        topicRequestsUsed: 0,
        maxTopicRequests: 10,
        dateOfBirth: dob,
        parentalConsentVerified: age < 13 ? parentConsent : true,
      });
      console.log("TRACE: User doc created in Firestore successfully.");

      console.log("TRACE 7: Redirecting to /chat");
      navigate("/chat");
    } catch (err: any) {
      console.error("TRACE 8: Exact stack trace / exception in handleSignUp:", err);
      if (err.response) {
        console.error("TRACE 8: Response error details status:", err.response.status, "data:", JSON.stringify(err.response.data));
      }
      const errorCode = err?.code || "";
      setError(getErrorMessage(errorCode) || err.message || "Signup failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    setIsLoading(true);
    setError("");

    try {
      console.log("TRACE: starting handleGoogleSignUp via signInWithPopup...");
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;
      console.log("TRACE 1: Firebase User Object (Google Signup):", JSON.stringify({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL
      }, null, 2));

      console.log("TRACE: retrieving Firebase ID Token...");
      // Exchange Firebase Token for local custom JWT session
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

      console.log("TRACE: creating / checking user profile document in Firestore...");
      // Check if this is a new user and store additional data
      const userDoc = doc(db, "users", user.uid);
      await setDoc(
        userDoc,
        {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          createdAt: new Date().toISOString(),
          isPro: false,
          topicRequestsUsed: 0,
          maxTopicRequests: 10,
          photoURL: user.photoURL,
        },
        { merge: true }
      );
      console.log("TRACE: User doc merged in Firestore successfully.");

      console.log("TRACE 7: Redirecting to /chat");
      navigate("/chat");
    } catch (err: any) {
      console.error("TRACE 8: Exact stack trace / exception in handleGoogleSignUp:", err);
      if (err.response) {
        console.error("TRACE 8: Response error details status:", err.response.status, "data:", JSON.stringify(err.response.data));
      }
      const errorCode = err?.code || "";
      setError(getErrorMessage(errorCode) || err.message || "Google signup failed");
    } finally {
      setIsLoading(false);
    }
  };

  const getErrorMessage = (errorCode: string): string => {
    switch (errorCode) {
      case "auth/email-already-in-use":
        return "This email is already registered. Try signing in instead.";
      case "auth/weak-password":
        return "Password should be at least 6 characters long.";
      case "auth/invalid-email":
        return "Please enter a valid email address.";
      case "auth/network-request-failed":
        return "Network error. Please check your connection.";
      case "auth/popup-closed-by-user":
        return "Sign-up was cancelled.";
      default:
        return "Signup failed. Please try again.";
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-black">
      {/* Sparkles Background */}
      <div className="absolute inset-0 w-full h-full">
        <SparklesCore
          id="signup-sparkles"
          background="transparent"
          minSize={0.4}
          maxSize={1.2}
          particleDensity={80}
          className="w-full h-full"
          particleColor="#FFFFFF"
        />
      </div>

      <div className="relative w-full max-w-md z-10">
        {/* Modular Black Signup Card */}
        <div className="absolute inset-0 bg-black/90 backdrop-blur-sm rounded-3xl shadow-2xl border border-[#232323]" />
        <div className="relative p-8 z-10">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">
              Sign Up for Lerno AI
            </h1>
            <p className="text-gray-400">
              Create your account to start learning
            </p>
          </div>

          <form onSubmit={handleSignUp} className="space-y-6">
            {/* Name field */}
            <div className="relative">
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Full Name
              </label>
              <div className="relative">
                <User className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 z-10 pointer-events-none" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full pl-12 pr-4 py-4 bg-[#191919]/80 backdrop-blur-sm border border-[#333333] rounded-2xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:border-gray-600 transition-all duration-300 relative z-0"
                  placeholder="Enter your full name"
                  required
                />
              </div>
            </div>

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
                  onChange={(e) => setEmail(e.target.value)}
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
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-12 pr-4 py-4 bg-[#191919]/80 backdrop-blur-sm border border-[#333333] rounded-2xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:border-gray-600 transition-all duration-300 relative z-0"
                  placeholder="Enter your password (min 6 characters)"
                  required
                  minLength={6}
                />
              </div>
            </div>

            {/* Date of Birth field */}
            <div className="relative">
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Date of Birth
              </label>
              <div className="relative">
                <Calendar className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 z-10 pointer-events-none" />
                <input
                  type="date"
                  value={dob}
                  onChange={handleDobChange}
                  className="w-full pl-12 pr-4 py-4 bg-[#191919]/80 backdrop-blur-sm border border-[#333333] rounded-2xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:border-gray-600 transition-all duration-300 relative z-0"
                  required
                />
              </div>
            </div>

            {/* COPPA Gated Parental Consent Checkbox */}
            {showConsent && (
              <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl space-y-3 backdrop-blur-sm">
                <p className="text-xs text-indigo-300 leading-relaxed">
                  📢 <strong>COPPA Gating Notice:</strong> Since you are under 13, a parent must explicitly check this box to confirm consent for telemetry tracking and learning personalization.
                </p>
                <label className="flex items-start space-x-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={parentConsent}
                    onChange={(e) => setParentConsent(e.target.checked)}
                    className="w-5 h-5 mt-0.5 rounded border-[#333333] bg-[#191919]/80 accent-indigo-500"
                  />
                  <span className="text-sm text-gray-300 leading-snug select-none">
                    I confirm that my parent has consented to my use of Lerno.ai and personalized telemetry tracking.
                  </span>
                </label>
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm backdrop-blur-sm">
                {error}
              </div>
            )}

            {/* Signup button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-[#191919]/80 backdrop-blur-sm text-white font-semibold rounded-2xl py-3 mt-2 hover:bg-[#232323]/80 transition cursor-pointer disabled:opacity-50"
            >
              {isLoading ? (
                <div className="flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></div>
                  Creating Account...
                </div>
              ) : (
                <div className="flex items-center justify-center space-x-2">
                  <span>Create Account</span>
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

          {/* Google signup */}
          <button
            type="button"
            onClick={handleGoogleSignUp}
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
            <span>{isLoading ? "Signing up..." : "Continue with Google"}</span>
          </button>

          {/* Sign in link */}
          <div className="text-center mt-8 text-gray-400">
            <p>
              Already have an account?{" "}
              <button
                onClick={() => navigate("/login")}
                className="text-gray-300 hover:text-white transition-colors font-semibold underline cursor-pointer"
              >
                Sign in
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignUp;
