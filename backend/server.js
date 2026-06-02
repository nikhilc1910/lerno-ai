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
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { createClient } from "redis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env files from both root and backend directory for max compatibility
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, ".env") });

// Define PII Scrubbing patterns
const EMAIL_REGEX = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
const PHONE_REGEX = /\+?\b[1-9]\d{1,14}\b/g;
const LAT_LONG_REGEX = /\b[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)\b/g;

function scrubPII(input) {
  if (input === undefined || input === null) return input;
  if (typeof input !== 'string') {
    try {
      input = JSON.stringify(input);
    } catch {
      return input;
    }
  }
  return input
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(PHONE_REGEX, '[REDACTED_PHONE]')
    .replace(LAT_LONG_REGEX, '[REDACTED_COORDINATES]');
}

// Override console methods to ensure PII is scrubbed in all server log outputs
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => originalLog(...args.map(scrubPII));
console.error = (...args) => originalError(...args.map(scrubPII));
console.warn = (...args) => originalWarn(...args.map(scrubPII));

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(cors());
app.use(helmet());
app.use('/narrations', express.static(path.join(__dirname, 'narrations')));
app.use('/reports', express.static(path.join(__dirname, 'reports')));

const FASTAPI_URL = process.env.FASTAPI_URL || "http://localhost:8000";

// Redis Client Setup
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = createClient({ url: redisUrl });

let redisConnected = false;

redisClient.on("error", (err) => {
  console.warn("Redis connection error, falling back to local memory store:", err.message);
  redisConnected = false;
});

redisClient.on("connect", () => {
  console.log("Redis client connected successfully.");
  redisConnected = true;
});

// Async IIFE to connect Redis
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.warn("Failed to connect to Redis on startup, using memory fallback:", err.message);
  }
})();

// Custom Redis Store for express-rate-limit that falls back gracefully
class CustomRedisStore {
  constructor(prefix, windowMs) {
    this.prefix = prefix;
    this.windowMs = windowMs;
    this.localStore = {};
  }

  async increment(key) {
    const fullKey = `${this.prefix}:${key}`;
    const now = Date.now();
    const expiry = now + this.windowMs;

    if (redisConnected) {
      try {
        const count = await redisClient.incr(fullKey);
        if (count === 1) {
          await redisClient.expire(fullKey, Math.ceil(this.windowMs / 1000));
        }
        const ttl = await redisClient.ttl(fullKey);
        return {
          totalHits: count,
          resetTime: new Date(Date.now() + (ttl > 0 ? ttl * 1000 : this.windowMs))
        };
      } catch (err) {
        console.warn(`Redis store error for key ${fullKey}, falling back to memory:`, err.message);
      }
    }

    // Local memory fallback
    if (!this.localStore[key] || this.localStore[key].resetTime < now) {
      this.localStore[key] = {
        totalHits: 0,
        resetTime: now + this.windowMs
      };
    }
    this.localStore[key].totalHits += 1;
    return {
      totalHits: this.localStore[key].totalHits,
      resetTime: new Date(this.localStore[key].resetTime)
    };
  }

  async decrement(key) {
    const fullKey = `${this.prefix}:${key}`;
    if (redisConnected) {
      try {
        await redisClient.decr(fullKey);
        return;
      } catch (err) {
        console.warn(`Redis decr error for key ${fullKey}, falling back to memory:`, err.message);
      }
    }
    if (this.localStore[key]) {
      this.localStore[key].totalHits = Math.max(0, this.localStore[key].totalHits - 1);
    }
  }

  async resetKey(key) {
    const fullKey = `${this.prefix}:${key}`;
    if (redisConnected) {
      try {
        await redisClient.del(fullKey);
        return;
      } catch (err) {
        console.warn(`Redis del error for key ${fullKey}, falling back to memory:`, err.message);
      }
    }
    delete this.localStore[key];
  }
}

// Global Rate Limiter
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 300,                  // 300 requests per minute total
  standardHeaders: true,
  store: new CustomRedisStore("rl:global", 60 * 1000),
  message: { error: 'Too many requests, slow down.' }
});
app.use(globalLimiter);

// Strict Rate Limiters
const lessonLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minute window
  max: 3,                    // max 3 lesson generations per 10 min
  keyGenerator: (req) => req.user?.uid || req.ip,  // per-user, not per-IP
  store: new CustomRedisStore("rl:lesson", 10 * 60 * 1000),
  message: { error: 'Lesson generation limit reached. Wait a few minutes.' }
});

const callLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour window
  max: 2,                    // max 2 calls per hour per user
  keyGenerator: (req) => req.user?.uid || req.ip,
  store: new CustomRedisStore("rl:call", 60 * 60 * 1000),
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
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "lerno-ai-5b547.firebasestorage.app"
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (err) {
    console.error("Failed to initialize Firebase Admin SDK:", err.message);
  }
} else {
  console.warn("FIREBASE_CREDENTIALS_JSON environment variable is not defined.");
}

const JWT_SECRET = process.env.JWT_SECRET || "lerno-access-secret-key-15m-jwt-token-xyz123";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "lerno-refresh-secret-key-long-lived-xyz123";

// Generate Access Token (expires in 15 minutes)
function generateAccessToken(user) {
  return jwt.sign(
    { uid: user.uid, email: user.email, role: user.role || 'child_user' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

// Generate Refresh Token (expires in 7 days)
function generateRefreshToken(user) {
  return jwt.sign(
    { uid: user.uid, email: user.email, role: user.role || 'child_user' },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
}

// Authentication Middleware
async function requireAuth(req, res, next) {
  // Exclude auth routes from validation
  if (req.path === '/api/auth/session' || req.path === '/api/auth/refresh' || req.path === '/api/auth/logout') {
    return next();
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    console.error("Token verification error:", e.message);
    return res.status(401).json({ error: 'Invalid or expired access token' });
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

// JWT session issuing endpoint
app.post("/api/auth/session", async (req, res) => {
  console.log("SERVER TRACE: Received request on /api/auth/session");
  const authHeader = req.headers.authorization || '';
  console.log("SERVER TRACE: Authorization Header:", authHeader ? `${authHeader.slice(0, 20)}... (Length: ${authHeader.length})` : "NONE");
  
  const firebaseToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (!firebaseToken) {
    console.warn("SERVER TRACE: Missing Firebase token in Authorization header");
    return res.status(401).json({ error: "Missing Firebase token" });
  }

  try {
    let decodedUser;
    console.log("SERVER TRACE: Firebase Admin apps initialized count:", admin.apps.length);
    if (!admin.apps.length) {
      console.warn("SERVER TRACE: Firebase Admin SDK is NOT initialized. Falling back to local/mock user extraction.");
      decodedUser = {
        uid: firebaseToken === "mock-token" || firebaseToken === "defaultUser" ? "defaultUser" : firebaseToken,
        email: "student@lerno.ai",
        role: "child_user"
      };
      console.log("SERVER TRACE: Mock decodedUser details:", JSON.stringify(decodedUser));
    } else {
      console.log("SERVER TRACE: Verifying Firebase ID Token with Admin SDK...");
      decodedUser = await admin.auth().verifyIdToken(firebaseToken);
      console.log("SERVER TRACE: Successfully verified ID token. Decoded User UID:", decodedUser.uid, "Email:", decodedUser.email);
    }

    const userPayload = { uid: decodedUser.uid, email: decodedUser.email, role: decodedUser.role || 'child_user' };
    console.log("SERVER TRACE: Creating user payload:", JSON.stringify(userPayload));
    
    console.log("SERVER TRACE: Generating access token...");
    const accessToken = generateAccessToken(userPayload);
    console.log("SERVER TRACE: Access token generated. Length:", accessToken.length);

    console.log("SERVER TRACE: Generating refresh token...");
    const refreshToken = generateRefreshToken(userPayload);
    console.log("SERVER TRACE: Refresh token generated. Length:", refreshToken.length);

    console.log("SERVER TRACE: Setting httpOnly cookie 'refreshToken'...");
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    console.log("SERVER TRACE: Cookie set successfully.");

    console.log("SERVER TRACE: Returning response to client...");
    res.json({ accessToken, user: userPayload });
  } catch (error) {
    console.error("SERVER TRACE ERROR: Session creation error:", error.message, error.stack);
    res.status(401).json({ error: "Invalid Firebase token", details: error.message, stack: error.stack });
  }
});

// JWT session refresh endpoint
app.post("/api/auth/refresh", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ error: "Refresh token missing" });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const userPayload = { uid: decoded.uid, email: decoded.email, role: decoded.role || "child_user" };
    const accessToken = generateAccessToken(userPayload);
    res.json({ accessToken });
  } catch (error) {
    console.error("Token refresh error:", error.message);
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

// Logout endpoint
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("refreshToken");
  res.json({ message: "Logged out successfully" });
});

// Protect all /api/ routes
app.use("/api/", requireAuth);

// Parent Control Center
app.get("/api/parent/child-data", requireAuth, async (req, res) => {
  // Allow both super_parent and default child in local development
  if (req.user.role !== 'super_parent' && req.user.uid !== 'defaultUser') {
    return res.status(403).json({ error: "Access denied. Requires super_parent role." });
  }

  try {
    const response = await axios.get(`${FASTAPI_URL}/parent/child-data`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user.uid,
        "x-user-email": req.user.email,
        "x-user-role": req.user.role
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Failed to get child data:", error.message);
    res.status(500).json({ error: "Failed to fetch child details from database" });
  }
});

app.delete("/api/parent/child-data", requireAuth, async (req, res) => {
  if (req.user.role !== 'super_parent' && req.user.uid !== 'defaultUser') {
    return res.status(403).json({ error: "Access denied. Requires super_parent role." });
  }

  try {
    const response = await axios.delete(`${FASTAPI_URL}/parent/child-data`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user.uid,
        "x-user-email": req.user.email,
        "x-user-role": req.user.role
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Failed to delete child data:", error.message);
    res.status(500).json({ error: "Failed to purge child data" });
  }
});

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
          Authorization: req.headers.authorization,
          "x-user-id": req.user?.uid || "",
          "x-user-email": req.user?.email || "",
          "x-user-role": req.user?.role || ""
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

// Proxy for ElevenLabs Speech Generation
app.post("/api/generate-speech-elevenlabs", async (req, res) => {
  try {
    const { text, voiceId } = req.body;
    const apiKey = process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "ELEVENLABS_API_KEY not configured on server" });
    }

    const targetVoiceId = voiceId || "pNInz6obpgq5paNs9W5y"; // default Spark/Rachel voice

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${targetVoiceId}`,
      {
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      },
      {
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
      }
    );

    // Save audio buffer to Firebase Storage
    const bucket = admin.storage().bucket();
    const fileName = `elevenlabs/${Date.now()}_${Math.floor(Math.random() * 100000)}.mp3`;
    const file = bucket.file(fileName);

    await file.save(Buffer.from(response.data), {
      metadata: {
        contentType: "audio/mpeg",
      },
    });

    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    res.json({ audioUrl: publicUrl });
  } catch (error) {
    console.error("ElevenLabs speech generation proxy error:", error.message);
    res.status(error.response?.status || 500).json({
      error: "ElevenLabs speech generation failed",
      details: error.response?.data || error.message,
    });
  }
});

// Proxy for modular ElevenLabs Narration Service
app.post("/api/narrate-elevenlabs", requireAuth, async (req, res) => {
  try {
    const { text, companionType } = req.body;
    if (!text || !companionType) {
      return res.status(400).json({ error: "text and companionType are required in request body." });
    }

    const response = await axios.post(`${FASTAPI_URL}/narrate-elevenlabs`, {
      text,
      companion_type: companionType
    }, {
      headers: {
        Authorization: req.headers.authorization,
        "Content-Type": "application/json",
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });

    // Resolve static audio URL relative to current Express server host
    const audioPath = response.data.audioUrl;
    const protocol = req.protocol;
    const host = req.get("host");
    const fullAudioUrl = `${protocol}://${host}${audioPath}`;

    res.json({ audioUrl: fullAudioUrl });
  } catch (error) {
    console.error("ElevenLabs narration proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to generate narration via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to generate narration" });
    }
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
  // Allow up to 8000 chars per message — AI chatbot sends full lesson context + instructions
  const hasOversized = messages.some(
    (m) => typeof m.content !== "string" || m.content.length > 8000
  )
  if (hasOversized) {
    return res.status(400).json({ error: "A message exceeds the 8000 character limit" })
  }

  try {
    const { contents, generationConfig } = req.body;
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.VITE_GEMINI_API_KEY || "AIzaSyCGTV-hfbcGYqbXZdFSi_LkctKNsZUP7w4";

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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

// ── Gemini-powered instant lesson generation (no Manim, results in seconds) ──
app.post("/api/generate-lesson-gemini", requireAuth, lessonLimiter, validateLessonBody, async (req, res) => {
  const { topic } = req.body;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.VITE_GEMINI_API_KEY || "AIzaSyCGTV-hfbcGYqbXZdFSi_LkctKNsZUP7w4";

  const prompt = `You are an expert educational content creator for children aged 8-16. Generate a 3-scene visual lesson about: "${topic}"

CRITICAL RULES:
- Each narration must be 2-3 sentences max (under 40 words)
- Keep language simple, engaging, and age-appropriate
- Make MCQ questions directly related to the narration content
- Place the correct answer at a RANDOM position (not always index 1)
- The correct_index must match the actual correct choice (0=A, 1=B, 2=C, 3=D)

Return ONLY valid JSON — no markdown fences, no explanation, nothing else:
{
  "metadata": { "topic": "${topic}", "audience": "student" },
  "scenes": [
    {
      "scene_number": 1,
      "title": "3-5 word scene title",
      "narration": "2-3 sentence engaging explanation for a child.",
      "animation_description": "Describe the visual: objects, movements, colors, layout on screen.",
      "assessment": {
        "multiple_choice": {
          "question": "Question testing understanding of this scene?",
          "choices": ["A. option", "B. option", "C. option", "D. option"],
          "correct_index": 0
        },
        "free_response": {
          "question": "Open-ended question about this scene?",
          "answer": "Expected answer explanation"
        }
      }
    },
    {
      "scene_number": 2,
      "title": "3-5 word scene title",
      "narration": "2-3 sentence engaging explanation for a child.",
      "animation_description": "Describe the visual: objects, movements, colors, layout on screen.",
      "assessment": {
        "multiple_choice": {
          "question": "Question testing understanding of this scene?",
          "choices": ["A. option", "B. option", "C. option", "D. option"],
          "correct_index": 2
        },
        "free_response": {
          "question": "Open-ended question about this scene?",
          "answer": "Expected answer explanation"
        }
      }
    },
    {
      "scene_number": 3,
      "title": "3-5 word scene title",
      "narration": "2-3 sentence engaging explanation for a child.",
      "animation_description": "Describe the visual: objects, movements, colors, layout on screen.",
      "assessment": {
        "multiple_choice": {
          "question": "Question testing understanding of this scene?",
          "choices": ["A. option", "B. option", "C. option", "D. option"],
          "correct_index": 1
        },
        "free_response": {
          "question": "Open-ended question about this scene?",
          "answer": "Expected answer explanation"
        }
      }
    }
  ]
}`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.75,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 3000,
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Extract JSON even if Gemini wraps it in markdown fences
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "Gemini returned no valid JSON", raw: rawText.slice(0, 300) });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const scenes = parsed.scenes || [];

    if (!scenes.length) {
      return res.status(500).json({ error: "Gemini returned empty scenes array" });
    }

    console.log(`Gemini lesson generated for topic "${topic}" — ${scenes.length} scenes`);
    res.json({
      success: true,
      metadata: parsed.metadata || { topic, audience: "student" },
      scenes,
    });
  } catch (error) {
    console.error("Gemini lesson generation error:", error.message);
    if (error instanceof SyntaxError) {
      return res.status(500).json({ error: "Gemini returned malformed JSON", details: error.message });
    }
    res.status(error.response?.status || 500).json({
      error: "Gemini lesson generation failed",
      details: error.response?.data || error.message,
    });
  }
});

// Proxy for job status polling
app.get("/api/job-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const response = await axios.get(`${FASTAPI_URL}/job-status/${jobId}`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Job status proxy error:", error.message);
    res.status(error.response?.status || 500).json({
      error: "Failed to get job status",
      details: error.response?.data || error.message,
    });
  }
});

// Proxy for Telemetry Ingestion
app.post("/api/telemetry", requireAuth, async (req, res) => {
  try {
    const response = await axios.post(`${FASTAPI_URL}/telemetry`, req.body, {
      headers: {
        Authorization: req.headers.authorization,
        "Content-Type": "application/json",
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Telemetry proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to forward telemetry to FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to send telemetry to FastAPI" });
    }
  }
});

// Proxy for Profile Update
app.post("/api/profile/update", requireAuth, async (req, res) => {
  try {
    const response = await axios.post(`${FASTAPI_URL}/profile/update`, req.body, {
      headers: {
        Authorization: req.headers.authorization,
        "Content-Type": "application/json",
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Profile update proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to update profile via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to update profile" });
    }
  }
});

// Proxy for Profile Retrieval
app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_URL}/profile`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Profile get proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to get profile via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to get profile" });
    }
  }
});

// Proxy for profile/xp
app.post("/api/profile/xp", requireAuth, async (req, res) => {
  try {
    const response = await axios.post(`${FASTAPI_URL}/profile/xp`, req.body, {
      headers: {
        Authorization: req.headers.authorization,
        "Content-Type": "application/json",
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("XP post proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to award XP via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to award XP" });
    }
  }
});

// Proxy for leaderboard
app.get("/api/leaderboard", requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_URL}/leaderboard`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Leaderboard get proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to fetch leaderboard via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to get leaderboard" });
    }
  }
});

// Proxy for skills retrieval
app.get("/api/skills", requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_URL}/skills`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Skills get proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to get unlocked skills via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to get unlocked skills" });
    }
  }
});

// Proxy for unlocking a skill
app.post("/api/skills/unlock", requireAuth, async (req, res) => {
  try {
    const response = await axios.post(`${FASTAPI_URL}/skills/unlock`, req.body, {
      headers: {
        Authorization: req.headers.authorization,
        "Content-Type": "application/json",
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Skills unlock post proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to unlock skill via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to unlock skill" });
    }
  }
});

// Proxy for parent analytics report
app.get("/api/parent/analytics/report", requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_URL}/parent/analytics/report`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    // Resolve static PDF URL relative to current Express server host
    if (response.data && response.data.report_url) {
      const protocol = req.protocol;
      const host = req.get("host");
      response.data.report_url = `${protocol}://${host}${response.data.report_url}`;
    }
    res.json(response.data);
  } catch (error) {
    console.error("Parent analytics report get proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to compile weekly parent report via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to compile weekly parent report" });
    }
  }
});

// Proxy for World State
app.get("/api/world/state", requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_URL}/world/state`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("World state get proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to get world state via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to get world state" });
    }
  }
});

// Proxy for Milestones Ingestion
app.post("/api/milestones", requireAuth, async (req, res) => {
  try {
    const response = await axios.post(`${FASTAPI_URL}/milestones`, req.body, {
      headers: {
        Authorization: req.headers.authorization,
        "Content-Type": "application/json",
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Milestones proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to save milestone via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to save milestone" });
    }
  }
});

// Proxy for Boredom Check
app.get("/api/boredom-check", requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_URL}/boredom-check`, {
      headers: {
        Authorization: req.headers.authorization,
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Boredom check proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to fetch boredom prediction",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to calculate boredom status" });
    }
  }
});

// Proxy for Companion and World Score Update
app.post("/api/world/companion", requireAuth, async (req, res) => {
  try {
    const response = await axios.post(`${FASTAPI_URL}/world/companion`, req.body, {
      headers: {
        Authorization: req.headers.authorization,
        "Content-Type": "application/json",
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("World/companion proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to update companion score via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to update companion score" });
    }
  }
});

// Moderated Chat Endpoint for Child Safety Compliance
app.post("/api/multiplayer/moderate-chat", requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: "message string is required" });
  }
  
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.VITE_GEMINI_API_KEY || "AIzaSyCGTV-hfbcGYqbXZdFSi_LkctKNsZUP7w4";
  
  try {
    const prompt = `You are a strict child-safety content moderation system for an ed-tech learning app. Censor/redact any PII (names, emails, phone numbers, addresses) with [REDACTED]. Also censor any vulgarity, cyberbullying, or inappropriate words with stars (****). If the message is completely unsafe (hate speech, violence, severe abuse), replace the whole message with "[Blocked for safety]". Return ONLY the moderated text, no preamble or quotes.

Message to moderate: "${message}"`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 200,
        }
      },
      {
        headers: {
          "Content-Type": "application/json",
        }
      }
    );

    const sanitizedText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || message;
    res.json({ sanitized: sanitizedText });
  } catch (error) {
    console.error("Gemini chat moderation error:", error.message);
    if (error.response) {
      console.error("Gemini moderation error response:", JSON.stringify(error.response.data));
    }
    const sanitized = message
      .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
      .replace(PHONE_REGEX, '[REDACTED_PHONE]');
    res.json({ sanitized });
  }
});

// Cooperative Boss Battle Rewards Endpoint
app.post("/api/multiplayer/boss-rewards", requireAuth, async (req, res) => {
  try {
    const response = await axios.post(`${FASTAPI_URL}/multiplayer/rewards`, req.body, {
      headers: {
        Authorization: req.headers.authorization,
        "Content-Type": "application/json",
        "x-user-id": req.user?.uid || "",
        "x-user-email": req.user?.email || "",
        "x-user-role": req.user?.role || ""
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Multiplayer boss rewards proxy error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Failed to allocate multiplayer rewards via FastAPI",
        details: error.response.data
      });
    } else {
      res.status(500).json({ error: "Failed to process multiplayer rewards" });
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`server is running on port ${PORT}`);
});

