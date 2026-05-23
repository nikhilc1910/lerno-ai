import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { readFileSync } from "fs";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env files from both root and backend directory for max compatibility
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());

const FASTAPI_URL = process.env.FASTAPI_URL || "http://localhost:8000";

// Global Rate Limiter
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 60,                   // 60 requests per minute total
  standardHeaders: true,
  message: { error: 'Too many requests, slow down.' }
});
app.use(globalLimiter);

// Strict Rate Limiters
const lessonLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minute window
  max: 3,                    // max 3 lesson generations per 10 min
  keyGenerator: (req) => req.user?.uid || req.ip,  // per-user, not per-IP
  message: { error: 'Lesson generation limit reached. Wait a few minutes.' }
});

const callLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour window
  max: 2,                    // max 2 calls per hour per user
  keyGenerator: (req) => req.user?.uid || req.ip,
  message: { error: 'Call limit reached. Try again in an hour.' }
});

// Firebase Admin initialization
let serviceAccount;
const credsEnv = process.env.FIREBASE_CREDENTIALS_JSON;
if (credsEnv) {
  try {
    if (credsEnv.trim().startsWith("{")) {
      serviceAccount = JSON.parse(credsEnv);
    } else {
      serviceAccount = JSON.parse(readFileSync(credsEnv, "utf8"));
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (err) {
    console.error("Failed to initialize Firebase Admin SDK:", err.message);
  }
} else {
  console.warn("FIREBASE_CREDENTIALS_JSON environment variable is not defined.");
}

// Authentication Middleware
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (e) {
    console.error("Token verification error:", e.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function validateLessonBody(req, res, next) {
  // Support both 'topic' and 'data' fields for compatibility
  const topic = req.body?.topic || req.body?.data;

  if (!topic || typeof topic !== "string") {
    return res.status(400).json({ error: "topic is required and must be a string" })
  }

  const trimmed = topic.trim()

  if (trimmed.length < 3) {
    return res.status(400).json({ error: "Topic too short — please be more specific" })
  }

  if (trimmed.length > 200) {
    return res.status(400).json({ error: `Topic too long (${trimmed.length}/200 chars)` })
  }

  // Scan for prompt injection phrases (reject with 400 at Express layer)
  const injectionPhrases = [
    "ignore previous", "ignore all", "ignore instructions",
    "system prompt", "jailbreak", "act as", "you are now",
    "disregard", "new instruction", "forget everything",
    "override", "do not follow"
  ]
  const lower = trimmed.toLowerCase()
  for (const phrase of injectionPhrases) {
    if (lower.includes(phrase)) {
      return res.status(400).json({ error: "Invalid topic — please enter a real learning subject" })
    }
  }

  // Hard-sanitise before forwarding to FastAPI
  req.body.topic = trimmed.slice(0, 200)
  next()
}

// Public Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Protect all /api/ routes
app.use("/api/", requireAuth);

// Proxy for FastAPI process-data
app.post("/api/input-data",
  requireAuth,
  lessonLimiter,
  validateLessonBody,
  async (req, res) => {
    try {
      const { topic } = req.body;
      console.log("Request data:", topic);

      const response = await axios.post(`${FASTAPI_URL}/process-data`, {
        topic: topic,
      }, {
        headers: {
          Authorization: req.headers.authorization
        }
      });

    res.json({ message: "Data sent to FastAPI", response: response.data });
  } catch (error) {
    console.log("Error forwarding to fastAPI", error.message);

    if (error.response) {
      console.log("Response status:", error.response.status);
      console.log("Response data:", error.response.data);
      res.status(error.response.status).json({
        error: "Failed to process data with FastAPI",
        details: error.response.data,
      });
    } else {
      res.status(500).json({ error: "Failed to send data to FastAPI" });
    }
  }
});

// Proxy for Murf Translation
app.post("/api/translate", async (req, res) => {
  try {
    const { targetLanguage, texts } = req.body;
    const apiKey = process.env.MURF_API_KEY || process.env.VITE_MURF_API;

    if (!apiKey) {
      return res.status(500).json({ error: "MURF_API_KEY not configured on server" });
    }

    const response = await axios.post(
      "https://api.murf.ai/v1/text/translate",
      { targetLanguage, texts },
      {
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Translation proxy error:", error.message);
    res.status(error.response?.status || 500).json({
      error: "Translation failed",
      details: error.response?.data || error.message,
    });
  }
});

// Proxy for Murf Speech Generation
app.post("/api/generate-speech", async (req, res) => {
  try {
    const { text, voiceId, format, channelType, sampleRate } = req.body;
    const apiKey = process.env.MURF_API_KEY || process.env.VITE_MURF_API;

    if (!apiKey) {
      return res.status(500).json({ error: "MURF_API_KEY not configured on server" });
    }

    const response = await axios.post(
      "https://api.murf.ai/v1/speech/generate",
      { text, voiceId, format, channelType, sampleRate },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "api-key": apiKey,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Speech generation proxy error:", error.message);
    res.status(error.response?.status || 500).json({
      error: "Speech generation failed",
      details: error.response?.data || error.message,
    });
  }
});

// Proxy for Vapi Call Initiation
app.post("/api/vapi-call", callLimiter, async (req, res) => {
  try {
    const { customer, metadata } = req.body;
    const apiKey = process.env.VAPI_API_KEY || process.env.VITE_VAPI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID || process.env.VITE_ASSISTANT_ID;
    const phoneNumberId = process.env.PHONE_NUMBER_ID || process.env.VITE_PHONE_NUMBER_ID;

    if (!apiKey) {
      return res.status(500).json({ error: "VAPI_API_KEY not configured on server" });
    }

    const response = await axios.post(
      "https://api.vapi.ai/call",
      {
        assistantId,
        phoneNumberId,
        customer,
        metadata,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Vapi call proxy error:", error.message);
    res.status(error.response?.status || 500).json({
      error: "Vapi call initiation failed",
      details: error.response?.data || error.message,
    });
  }
});

// Proxy for Gemini Chat API
app.post("/api/gemini-chat", async (req, res) => {
  // Normalize contents to messages for validation compatibility
  if (req.body.contents && !req.body.messages) {
    req.body.messages = req.body.contents.map(m => ({
      content: m.parts?.[0]?.text || ""
    }));
  }

  const { messages } = req.body ?? {}
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" })
  }
  if (messages.length > 50) {
    return res.status(400).json({ error: "Too many messages — max 50" })
  }
  const hasOversized = messages.some(
    (m) => typeof m.content !== "string" || m.content.length > 2000
  )
  if (hasOversized) {
    return res.status(400).json({ error: "A message exceeds the 2000 character limit" })
  }

  try {
    const { contents, generationConfig } = req.body;
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.VITE_GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
    }

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        contents,
        generationConfig: generationConfig || {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 200,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Gemini proxy error:", error.message);
    res.status(error.response?.status || 500).json({
      error: "Gemini query failed",
      details: error.response?.data || error.message,
    });
  }
});

// Proxy for job status polling
app.get("/api/job-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const response = await axios.get(`${FASTAPI_URL}/job-status/${jobId}`);
    res.json(response.data);
  } catch (error) {
    console.error("Job status proxy error:", error.message);
    res.status(error.response?.status || 500).json({
      error: "Failed to get job status",
      details: error.response?.data || error.message,
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`server is running on port ${PORT}`);
});

