<div align="center">

# 🧠 Lerno.ai

**An AI-powered adaptive learning platform that personalizes education through behavioral intelligence, real-time content generation, and cinematic storytelling.**

[![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react&logoColor=white)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Firebase](https://img.shields.io/badge/Firebase-Auth%20%7C%20Storage-FFCA28?logo=firebase&logoColor=black)](https://firebase.google.com/)
[![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[Features](#-features) • [Architecture](#-architecture) • [Tech Stack](#-tech-stack) • [Getting Started](#-getting-started) • [API Overview](#-api-overview) • [Roadmap](#-roadmap)

</div>

---

## 📋 Overview

Lerno.ai is an intelligent education platform that adapts in real-time to how each student learns. Unlike traditional e-learning tools that deliver static content, Lerno.ai uses **behavioral tracking**, **AI-generated visual explanations**, and **gamified progression systems** to create a unique learning experience for every user.

The platform combines a React/TypeScript frontend with a dual-backend architecture (Node.js + FastAPI) to deliver:
- **AI-generated animated video lessons** using Manim and LLM-powered scripting
- **Real-time behavioral intelligence** that detects engagement patterns
- **Adaptive narration** with ElevenLabs voice synthesis
- **Multiplayer collaborative learning** with real-time lobbies

---

## ✨ Features

### Core Learning Engine
- **AI Visual Explainer** — Generates animated math/science explanations using Manim, scripted by Claude and Gemini
- **Adaptive Difficulty** — Adjusts content pacing based on real-time behavioral signals
- **Multi-AI Chat** — Context-aware tutoring chatbot powered by Anthropic Claude and Google Gemini

### Behavioral Intelligence
- **Learning DNA Profiler** — Builds cognitive profiles from click patterns, dwell time, and interaction velocity
- **Engagement Detection** — Real-time boredom and frustration prediction with automatic content pivots
- **Telemetry Dashboard** — Tracks 15+ behavioral metrics per session

### Media & Narration
- **AI Voice Narration** — ElevenLabs-powered voice synthesis for every generated lesson
- **Dynamic Video Rendering** — Server-side Manim compilation with Firebase Storage delivery
- **Cinematic Onboarding** — Animated onboarding experience with particle effects

### Social & Gamification
- **Real-time Multiplayer Lobbies** — Collaborative learning sessions with live chat
- **XP & Streak System** — Gamified progression with daily streaks, achievements, and leaderboards
- **Interactive Quizzes** — AI-generated assessments with instant feedback

### Platform
- **Firebase Authentication** — Google SSO and email/password with secure JWT sessions
- **Responsive Design** — Optimized for desktop and tablet viewports
- **Dark Mode UI** — Premium glassmorphism design with Framer Motion animations

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Client (React + TS)                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │ Learning │ │ Onboard  │ │   Auth   │ │  Chatbot   │ │
│  │   Page   │ │ Cinematic│ │  Pages   │ │   Panel    │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬──────┘ │
│       └─────────────┴────────────┴─────────────┘        │
│                         │ Axios                         │
└─────────────────────────┼───────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼                               ▼
┌──────────────────┐           ┌──────────────────────┐
│  Node.js Gateway │           │   FastAPI ML Engine   │
│  (Express.js)    │           │   (Python)            │
│                  │           │                       │
│ • Auth sessions  │   HTTP    │ • AI lesson generation│
│ • JWT management │◄────────► │ • Manim rendering     │
│ • API proxying   │           │ • Behavioral analysis │
│ • Rate limiting  │           │ • Voice narration     │
│ • WebSocket mgmt │           │ • Quiz generation     │
└───────┬──────────┘           └───────┬──────────────┘
        │                              │
        ▼                              ▼
┌──────────────┐  ┌──────────┐  ┌──────────────┐
│   Firebase   │  │  SQLite  │  │  External    │
│ • Auth       │  │ Learning │  │  APIs        │
│ • Storage    │  │ Profiles │  │ • Claude     │
│ • Firestore  │  │ Telemetry│  │ • Gemini     │
└──────────────┘  └──────────┘  │ • ElevenLabs │
                                └──────────────┘
```

> For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, TypeScript, Tailwind CSS, Framer Motion, Phaser.js |
| **UI Components** | shadcn/ui, Aceternity UI, Lucide Icons, tsParticles |
| **Backend (Gateway)** | Node.js, Express.js, JWT, Firebase Admin SDK |
| **Backend (ML Engine)** | Python, FastAPI, LangChain, Pydantic |
| **AI Models** | Anthropic Claude 3.7, Google Gemini 2.0, ElevenLabs TTS |
| **Animation** | Manim (Mathematical Animation Engine) |
| **Database** | SQLite (dev), PostgreSQL (prod), Firebase Firestore |
| **Auth** | Firebase Authentication, Google OAuth 2.0 |
| **Storage** | Firebase Cloud Storage |
| **Build** | Vite 6, ESLint, TypeScript Compiler |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18.x
- **Python** ≥ 3.10
- **npm** ≥ 9.x
- Firebase project with Authentication and Storage enabled

### Installation

```bash
# Clone the repository
git clone https://github.com/nikhilc1910/lerno-ai.git
cd lerno-ai

# Install frontend dependencies
npm install

# Install backend dependencies
cd backend
pip install -r requirements.txt
cd ..
```

### Environment Setup

Copy the example environment file and add your credentials:

```bash
cp .env.example .env
```

#### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Express server port (default: 3001) | Yes |
| `FASTAPI_URL` | FastAPI backend URL | Yes |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | Yes |
| `GOOGLE_API_KEY` | Google Gemini API key | Yes |
| `FIREBASE_CREDENTIALS_JSON` | Firebase Admin SDK credential file path | Yes |
| `FIREBASE_STORAGE_BUCKET` | Firebase Storage bucket name | Yes |
| `VITE_SUPABASE_URL` | Supabase project URL | No |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key | No |

### Running Locally

Start all three services in separate terminals:

```bash
# Terminal 1 — Frontend (Vite dev server)
npm run dev

# Terminal 2 — Node.js Gateway
cd backend && node server.js

# Terminal 3 — FastAPI ML Engine
cd backend && uvicorn main:app --reload --port 8000
```

The application will be available at `http://localhost:5173`.

---

## 📡 API Overview

### Node.js Gateway (`localhost:3001`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/session` | Create authenticated session from Firebase token |
| `POST` | `/api/auth/refresh` | Refresh JWT access token |
| `GET` | `/api/user/profile` | Fetch user profile and preferences |
| `POST` | `/api/generate` | Proxy AI content generation to FastAPI |

### FastAPI ML Engine (`localhost:8000`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/generate-lesson` | Generate AI-animated lesson with Manim |
| `POST` | `/chat` | Multi-model AI tutoring chat |
| `POST` | `/generate-quiz` | Generate adaptive quiz questions |
| `POST` | `/telemetry` | Ingest behavioral telemetry events |
| `GET` | `/learning-dna/{user_id}` | Retrieve user cognitive profile |
| `POST` | `/narrate` | Generate ElevenLabs voice narration |

---

## 📸 Screenshots

> Screenshots coming soon — run the app locally to preview the full UI.

<!--
![Landing Page](docs/assets/landing.png)
![Learning Dashboard](docs/assets/dashboard.png)
![AI Chat](docs/assets/chat.png)
-->

---

## 🗺 Roadmap

- [x] Core AI lesson generation (Claude + Gemini)
- [x] Manim video rendering pipeline
- [x] Firebase Authentication (Google + Email)
- [x] Behavioral telemetry tracking
- [x] ElevenLabs voice narration
- [x] Real-time multiplayer lobbies
- [x] Gamification (XP, streaks, achievements)
- [ ] PostgreSQL migration for production
- [ ] Parent dashboard with weekly reports
- [ ] Mobile-responsive PWA
- [ ] CI/CD pipeline with GitHub Actions
- [ ] Internationalization (i18n)
- [ ] Advanced recommendation engine

---

## 📁 Project Structure

```
lerno-ai/
├── src/                        # Frontend source
│   ├── components/             # React components
│   ├── lib/                    # API clients and utilities
│   ├── services/               # Service layer
│   ├── ui/                     # Reusable UI primitives (Aceternity, shadcn)
│   ├── utils/                  # Behavioral tracking, helpers
│   └── main.tsx                # App entry point and routing
├── backend/
│   ├── main.py                 # FastAPI ML engine (96K LOC)
│   ├── server.js               # Express.js gateway
│   ├── services/               # Backend service modules
│   └── requirements.txt        # Python dependencies
├── scripts/                    # Database and migration scripts
├── docs/                       # Architecture and API documentation
├── public/                     # Static assets
└── package.json
```

---

## 🤝 Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://github.com/nikhilc1910">Nikhil C</a></sub>
</div>
