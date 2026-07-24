# Zero-Knowledge Gamified Fitness Platform

A privacy-first, full-stack strength training platform built around a **Zero-Knowledge Architecture**. All exercise logs and progress metrics are encrypted client-side with AES-256-GCM before they ever touch the cloud, so your personal health data remains inaccessible to the server operator while still enabling cross-device synchronization and gamified analytics.

---

## The Problem

Traditional workout apps collect sensitive personal health metrics on centralized servers. That creates several risks:

- **Privacy exposure**: server operators, attackers, or subpoenas can read your health data.
- **Vendor lock-in**: your training history is trapped in proprietary ecosystems.
- **Weak user control**: you cannot easily verify or limit who can read your logs.

## The Solution

This platform flips the trust model. The server only stores **opaque, encrypted payloads**. Encryption keys are derived from the user's credentials on the client using **Argon2id** and never leave the browser. The gamification engine (XP, tonnage, progressive overload) runs entirely in the browser on decrypted local data, then re-encrypts state updates for cloud storage.

## Key Features

- **Client-Side Cryptography**: Web Crypto API (AES-256-GCM) with keys derived via Argon2id from user credentials.
- **Zero-Knowledge Storage**: Node.js/Express API + PostgreSQL stores only encrypted blobs and authentication hashes.
- **Client-Side Gamification Engine**: XP, levels, badges, workout streaks, personal records, and progressive-overload analytics computed entirely in the browser.
- **Built-In Exercise Database**: searchable catalog of common strength exercises.
- **Custom Exercises**: add your own exercises on the fly with category and equipment tags.
- **Workout Plans**: reusable plan templates for full-body, upper/lower, and custom routines.
- **Active Workout Mode**: set logging with weight/reps, auto-calculated warmup sets, live workout timer, and rest timers between sets.
- **Persistent Active Workout**: leave the workout page and come back later—the timer keeps running and progress is synced.
- **Mid-Workout Editing**: add exercises during a workout, delete sets, and adjust reps/weight at any time.
- **Mobile-First Responsive Design**: touch-friendly controls and layouts that work on Android and iOS browsers.
- **Cross-Device Sync**: encrypted state is fetched and decrypted on any authenticated device.
- **Production-Ready Ops**: Docker containerization, TLS 1.3/mTLS ready, GitHub Actions CI/CD.

## Architecture

```
┌──────────────────────────────────────┐
│           Browser (Client)           │
│  ┌──────────────────────────────┐    │
│  │  Argon2id key derivation     │    │
│  │  AES-256-GCM encrypt/decrypt │    │
│  │  Gamification engine (XP,    │    │
│  │  tonnage, progressive        │    │
│  │  overload analytics)         │    │
│  └──────────────────────────────┘    │
└──────────────┬───────────────────────┘
               │ HTTPS / TLS 1.3
               ▼
───────────────────────────────────────┐
│        Node.js / Express API         │
│  • Stateless JWT auth                │
│  • Stores only encrypted payloads    │
│  • No access to plaintext keys/data  │
└──────────────┬───────────────────────┘
               │
               ▼
        ┌────────────┐
        │ PostgreSQL │
        │ users      │
        │ sync_data  │
        └────────────┘
```

## Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML5, Vanilla JavaScript, Web Crypto API |
| Key Derivation | Argon2id (via vendored `argon2-browser`) |
| Backend | Node.js, Express, JSON Web Tokens |
| Database | PostgreSQL 16 |
| Container | Docker, Docker Compose |
| CI/CD | GitHub Actions |

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/samueladegnan/zk-gamified-fitness-platform.git
cd zk-gamified-fitness-platform
npm run install:backend   # install backend dependencies
```

### 2. Configure the Environment

Copy the example backend environment file and edit it as needed:

```bash
cp backend/.env.example backend/.env
# Windows: copy backend\.env.example backend\.env
```

The defaults in `.env.example` work for the local Docker Compose database below.

### 3. Start the Services

```bash
npm run dev:infra   # starts PostgreSQL via Docker Compose
npm run migrate     # creates database tables
npm start           # starts the API on http://localhost:3000
```

### 4. Open the Client

Open `frontend/index.html` in a modern browser or serve it with any static server:

```bash
npm run dev:client   # serves the frontend on http://localhost:3001
```

Register an account, start a workout from the Plans tab, log sets with weight and reps, and watch the live workout timer and rest timers work. Your data is encrypted in the browser before it is sent to the API. When you finish a workout, the dashboard updates with XP, level progress, badges, and personal records.

> **Note:** The Argon2 WebAssembly binary is vendored in `frontend/vendor/argon2.min.js` so the app works offline and without relying on a CDN. Run `npm install` (root) to refresh this vendored asset when updating versions.

### Stopping / Resetting

```bash
npm run dev:stop   # kills any process on ports 3000, 3001, and 5432
```

## Troubleshooting

- **Port 3000 already in use**: A previous Node process is still running. Run `npm run dev:stop`, or on Windows use `npx kill-port 3000`.
- **CORS errors in development**: Make sure `NODE_ENV=development` is set (it is by default in `backend/.env.example`). In development, the API reflects the requesting origin.
- **Argon2 not loading**: Ensure you ran `npm install` at the project root; this vendors `frontend/vendor/argon2.min.js`.

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create a user account |
| POST | `/api/auth/login` | Authenticate and receive a JWT |
| GET | `/api/sync` | Fetch the user's encrypted payload |
| PUT | `/api/sync` | Store a new encrypted payload |

See `backend/server.js` for request/response schemas.

## Security Model

1. The server never receives the user's password.
2. The client derives two independent keys from the password with Argon2id + HKDF:
   - **Auth key**: used to authenticate with the API (hashed server-side).
   - **Encryption key**: used to encrypt/decrypt the fitness payload; never transmitted.
3. The server stores only the authentication hash and the encrypted blob.
4. All transport is encrypted with TLS 1.3.

### Known Limitations

- **Deterministic salt**: the client currently derives the salt from the username. A production-grade implementation should generate a per-user random salt, store it server-side, and fetch it before deriving keys.
- **Password-equivalent authentication**: the derived auth key is sent to the API over TLS and verified with a server-side hash. For a stricter zero-knowledge model, consider SRP or OPAQUE in the future.
- **No offline persistence**: workout data lives in memory; closing the tab without syncing loses unsynced data. IndexedDB/offline caching is on the roadmap.

## Workout Tracking Features

### Active Workout
- **Live timer**: tracks total workout duration and keeps ticking while you browse other views.
- **Set logging**: enter weight and reps for each set, mark sets complete with one tap.
- **Rest timers**: a configurable countdown starts automatically when you complete a set.
- **Warmup sets**: auto-generated from your last working weight and inserted before working sets.
- **Add exercises mid-workout**: open the Exercise Database during a workout to add any exercise.
- **Edit on the fly**: add or delete sets, remove exercises, and change weight/reps at any time.
- **Persistence**: your active workout is saved with every change, so you can leave and resume later.

### Gamification
- **XP & Levels**: earn XP for every set and bonus XP for completing a workout; level up as you accumulate XP.
- **Badges**: unlock badges for milestones like first workout, 10 workouts, heavy lifter, and XP grinder.
- **Personal Records**: the app tracks the heaviest successful set for each exercise and shows recent PRs on the dashboard.
- **Streaks**: consecutive training days are tracked and displayed on the dashboard.
- **Tonnage**: total volume lifted across all workouts is tracked in your preferred units.

### Exercise Database
- **Built-in catalog**: common strength exercises with category and equipment metadata.
- **Custom exercises**: add your own exercises with custom name, category, and equipment.
- **Filtering**: filter exercises by category to find the right movement quickly.

## Roadmap

- [ ] Offline-first IndexedDB caching.
- [ ] mTLS enforcement between client and API.
- [ ] Audit logging of sync events without exposing payload contents.

## License

MIT © Samuel Degnan
