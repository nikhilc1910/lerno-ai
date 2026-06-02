# Lerno.ai — System Architecture

This document describes the high-level architecture, system departments, data flow, and infrastructure strategy for Lerno.ai.

---

## System Overview

Lerno.ai is split into a **three-tier architecture**:

1. **Client Tier** — React/TypeScript SPA with behavioral telemetry collection
2. **Gateway Tier** — Node.js/Express API handling authentication, sessions, and request proxying
3. **ML Engine Tier** — Python/FastAPI backend for AI lesson generation, video rendering, and cognitive analysis

```
┌──────────────────────────────────────────────────┐
│               Client (React + TypeScript)        │
│                                                  │
│  LandingPage → Auth → LearningPage → Chatbot    │
│                    │                             │
│          BehavioralTracker (telemetry)            │
└─────────────────────┬────────────────────────────┘
                      │ HTTPS / Axios
          ┌───────────┼───────────┐
          ▼                       ▼
┌──────────────────┐   ┌──────────────────────┐
│  Express Gateway │   │   FastAPI ML Engine   │
│  :3001           │   │   :8000               │
│                  │   │                       │
│  • Firebase Auth │   │  • LangChain agents   │
│  • JWT sessions  │   │  • Manim rendering    │
│  • Rate limiting │   │  • ElevenLabs TTS     │
│  • CORS / Helmet │   │  • Telemetry ingest   │
└──────┬───────────┘   └───────┬──────────────┘
       │                       │
       ▼                       ▼
┌────────────┐  ┌────────┐  ┌────────────┐
│  Firebase  │  │ SQLite │  │ AI APIs    │
│  Auth      │  │ (dev)  │  │ Claude 3.7 │
│  Storage   │  │ Pg     │  │ Gemini 2.0 │
│  Firestore │  │ (prod) │  │ ElevenLabs │
└────────────┘  └────────┘  └────────────┘
```

---

## Core Departments

### 1. Authentication & Identity
- **Tech:** Firebase Auth (Google SSO, email/password), Express.js JWT middleware
- **Flow:** `signInWithPopup` → Firebase ID token → `/api/auth/session` → server-side JWT + refresh cookie
- **Storage:** Firebase Auth user records, JWT sessions in HTTP-only cookies

### 2. Learning DNA & Cognitive Intelligence
- **Tech:** Custom `BehavioralTracker` class (TypeScript), FastAPI telemetry endpoints
- **Signals tracked:** Click frequency, dwell time, scroll velocity, response latency, interaction patterns
- **Output:** Per-user cognitive profile stored in SQLite/PostgreSQL with normalized behavioral vectors

### 3. AI Content Generation
- **Tech:** LangChain (Anthropic + Google GenAI), Manim, ElevenLabs SDK
- **Flow:** User query → LLM generates Manim Python script → server compiles to MP4 → uploads to Firebase Storage → streams to client
- **Fallback:** If Manim compilation fails after 3 retries, serves a static explanation card

### 4. Narration Pipeline
- **Tech:** ElevenLabs API via `narration_service.py`
- **Flow:** Generated lesson text → ElevenLabs TTS → MP3 audio → Firebase Storage → synced playback with video slides

### 5. Gamification & Progression
- **Tech:** SQLite/PostgreSQL tables for XP, streaks, achievements
- **Features:** Daily streak tracking, XP accumulation, achievement unlocks, skill tree progression

### 6. Real-time Multiplayer
- **Tech:** Firebase Firestore real-time listeners, Express WebSocket management
- **Features:** Collaborative lobbies, live chat, co-op learning sessions

---

## Data Flow

### Lesson Generation Pipeline

```
User Input (topic)
    │
    ▼
Express Gateway ──► FastAPI /generate-lesson
                        │
                        ├──► Claude: Generate Manim script
                        │       │
                        │       ▼
                        ├──► Validate & compile Manim → MP4
                        │       │
                        │       ▼
                        ├──► ElevenLabs: Generate narration → MP3
                        │       │
                        │       ▼
                        └──► Upload to Firebase Storage
                                │
                                ▼
                        Return signed URLs to client
                                │
                                ▼
                        Client renders video + synced audio
```

### Authentication Flow

```
Google Sign-In Button
    │
    ▼
signInWithPopup(auth, googleProvider)
    │
    ▼
Firebase User Object + getIdToken()
    │
    ▼
POST /api/auth/session { firebaseToken }
    │
    ▼
Express: verifyIdToken() via Firebase Admin
    │
    ▼
Generate JWT access token + refresh cookie
    │
    ▼
Client stores session → redirect to /chat
```

---

## Database Schema (Simplified)

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `users` | `id`, `email`, `display_name`, `created_at` | User identity |
| `learning_dna_profiles` | `user_id`, `cognitive_vectors`, `engagement_score` | Behavioral profiles |
| `telemetry_events` | `user_id`, `event_type`, `metadata`, `timestamp` | Raw interaction data |
| `xp_logs` | `user_id`, `xp_earned`, `source`, `timestamp` | Gamification progress |
| `achievements` | `user_id`, `achievement_id`, `unlocked_at` | Achievement tracking |
| `generated_lessons` | `id`, `topic`, `video_url`, `audio_url`, `user_id` | Cached AI content |

---

## Infrastructure

### Current (MVP)
- **Frontend:** Vite dev server / static build
- **Backend:** Local Node.js + Python processes
- **Database:** SQLite (file-based)
- **Storage:** Firebase Cloud Storage
- **Auth:** Firebase Authentication

### Production Target
- **Frontend:** Vercel or Cloudflare Pages
- **Backend:** Railway / GCP Cloud Run (containerized)
- **Database:** PostgreSQL (Supabase or managed)
- **Cache:** Redis for sessions and rate limiting
- **CDN:** Cloudflare for static assets and media

---

## Security Considerations

- All API routes gated with JWT verification middleware
- Firebase Admin SDK for server-side token validation
- Rate limiting via `express-rate-limit` (60 req/min)
- Helmet.js for HTTP security headers
- CORS restricted to allowed origins
- Environment secrets never committed to version control
