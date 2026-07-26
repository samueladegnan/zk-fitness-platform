# Zero-Knowledge Fitness Platform

🌐 **Live Portfolio:** [View the live portfolio &rarr;](https://samueladegnan.github.io/zk-fitness-platform/)

A privacy-first, full-stack strength training platform built around a **Zero-Knowledge Architecture**. All exercise logs and progress metrics are encrypted client-side with AES-256-GCM before they ever touch the cloud, so your personal health data remains inaccessible to the server operator while still enabling cross-device synchronization and gamified analytics.

This implementation also incorporates **NIST-standard Post-Quantum Cryptography (PQC)**. Authentication uses **ML-DSA-65** (Dilithium) signatures, and every sync uses a fresh data key encapsulated with **ML-KEM-768** (Kyber), so the system remains secure even against future cryptographically relevant quantum computers.

---

## The Problem

Traditional workout apps collect sensitive personal health metrics on centralized servers. That creates several risks:

- **Privacy exposure**: server operators, attackers, or subpoenas can read your health data.
- **Vendor lock-in**: your training history is trapped in proprietary ecosystems.
- **Weak user control**: you cannot easily verify or limit who can read your logs.

## The Solution

This platform flips the trust model. The server only stores **opaque, encrypted payloads** and public keys. Keys are derived from the user's credentials on the client using **Argon2id** and never leave the browser. The gamification engine (XP, tonnage, progressive overload) runs entirely in the browser on decrypted local data, then re-encrypts state updates for cloud storage.

### Post-Quantum Cryptography

- **ML-DSA-65 (Dilithium)** signs a server-issued nonce during login. The server stores only the user's public key and verifies the signature without ever seeing the private key.
- **ML-KEM-768 (Kyber)** encapsulates a per-sync AES-256-GCM data key. The server stores only the ML-KEM ciphertext; the private key remains client-side.
- **AES-256-GCM** is used for bulk data encryption. AES-256 is already considered quantum-resistant for symmetric cryptography, so the post-quantum layer protects the key exchange and authentication paths.
- All PQC primitives are provided by `@noble/post-quantum`, a zero-dependency, auditable JavaScript library.

## Key Features

- **Client-Side Cryptography**: Web Crypto API (AES-256-GCM) with keys derived via Argon2id from user credentials.
- **Zero-Knowledge Storage**: Node.js/Express API + PostgreSQL stores only encrypted blobs and authentication hashes.
- **Client-Side Gamification Engine**: XP, levels, badges, workout streaks, personal records, and progressive-overload analytics computed entirely in the browser.
- **Strength & Cardio Tracking**: log weight/reps for strength exercises and distance, duration, heart rate, and calories for cardio.
- **Built-In Exercise Database**: searchable catalog of common strength and cardio exercises.
- **Custom Exercises**: add your own exercises on the fly with category and equipment tags.
- **Workout Plans**: reusable plan templates for full-body, upper/lower, and custom routines with a plan editor.
- **Active Workout Mode**: set logging with weight/reps, auto-calculated warmup sets, live workout timer, and rest timers between sets.
- **Persistent Active Workout**: leave the workout page and come back later-the timer keeps running and progress is synced.
- **Mid-Workout Editing**: add exercises during a workout, delete sets, and adjust reps/weight at any time.
- **Rest Timer with +/-30s Controls**: quickly adjust rest time during a workout with a tap.
- **Warmup Set Generator**: generate warmup sets based on your target working weight.
- **Barbell Math**: automatic plate calculation when entering weights.
- **Confetti & Sounds**: celebratory confetti on workout completion and audio cues for timers.
- **Demo / Portfolio Mode**: try the app instantly without a backend; data is stored locally.
- **Dark Mode**: toggle between light and dark themes.
- **Mobile-First Responsive Design**: touch-friendly controls and layouts that work on Android and iOS browsers.
- **Cross-Device Sync**: encrypted state is fetched and decrypted on any authenticated device.
- **Production-Ready Ops**: Docker containerization, TLS 1.3/mTLS ready, GitHub Actions CI/CD.

## Architecture

```
──────────────────────────────────────┐
│           Browser (Client)           │
│  ┌──────────────────────────────┐    │
│  │  Argon2id key derivation     │    │
│  │  ML-DSA / ML-KEM keypairs    │    │
│  │  AES-256-GCM encrypt/decrypt │    │
│  │  Gamification engine (XP,   │    │
│  │  tonnage, progressive        │    │
│  │  overload analytics)         │    │
│  └──────────────────────────────┘    │
└──────────────┬───────────────────────┘
               │ HTTPS / TLS 1.3
               ▼
┌──────────────────────────────────────┐
│        Node.js / Express API         │
│  • PQC signature auth (ML-DSA-65)    │
│  • Stores only public keys &         │
│    encrypted payloads                │
│  • No access to private keys/data      │
└─────────────────────────────────────┘
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
| Post-Quantum Crypto | ML-DSA-65, ML-KEM-768 (via `@noble/post-quantum`) |
| Symmetric Encryption | AES-256-GCM |
| Backend | Node.js, Express, JSON Web Tokens |
| Database | PostgreSQL 16 |
| Container | Docker, Docker Compose |
| CI/CD | GitHub Actions |

## Quick Start

### Prerequisites

- Node.js >= 20
- npm
- Docker and Docker Compose (for the local Postgres database)

### 1. Clone and install

```bash
git clone https://github.com/samueladegnan/zk-fitness-platform.git
cd zk-fitness-platform
npm run install:backend
```

### 2. Configure the environment

```bash
cp backend/.env.example backend/.env
# Windows: copy backend\.env.example backend\.env
```

The defaults in `backend/.env.example` are configured for the Docker Compose database in the next step. Leave `DATABASE_URL` commented out; the local backend uses the `DB_*` variables.

### 3. Start the local services

```bash
npm run dev:infra   # starts PostgreSQL via Docker Compose
npm run migrate     # creates database tables
npm start           # starts the API on http://localhost:3000
```

### 4. Serve the frontend

```bash
npm run dev:client   # serves the frontend on http://localhost:3001
```

Open `http://localhost:3001`, register an account, and start a workout.

> **Note:** The Argon2 WebAssembly binary is vendored in `frontend/vendor/argon2.min.js` so the app works offline. Run `npm install` at the project root to refresh this vendored asset when updating `argon2-browser`.

### Stop services

```bash
npm run dev:stop   # kills any process on ports 3000, 3001, and 5432
```

## Deploy the Backend

GitHub Pages hosts only the static frontend. To enable authentication and encrypted sync, deploy the Node.js/Express backend with a Postgres database.

| Component | Service | Plan |
|---|---|---|
| App hosting | [Render](https://render.com) web service | Free |
| Database | [Neon](https://neon.tech) Postgres | Free |

Free Render web services spin down after 15 minutes of inactivity. The first request after a cold start may take 30–60 seconds.

### Step 1: Create the Neon database

1. Sign in to [Neon](https://neon.tech) and create a new project.
2. Create a database named `fitness_db`.
3. Copy the **connection string**. It has the form:
   ```text
   postgresql://<user>:<password>@<host>.neon.tech/fitness_db?sslmode=require
   ```
4. Keep the `?sslmode=require` suffix. Store the connection string for Step 2.

### Step 2: Deploy the backend to Render

This repository includes `render.yaml`, a Render Blueprint.

1. Push the repository to GitHub.
2. In the Render dashboard, select **New +** > **Blueprint**.
3. Connect the GitHub repository and choose the `main` branch.
4. Render reads `render.yaml` and creates a web service named `zk-fitness-api`.
5. Open the service's **Environment** tab and add the following variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon connection string from Step 1 |
   | `JWT_SECRET` | Strong random secret (see below) |
   | `CLIENT_ORIGIN` | Your GitHub Pages origin, e.g. `https://<username>.github.io` |

   Generate a secret with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

   Paste the output into `JWT_SECRET`. Do not commit it.

6. Redeploy if necessary. The `start:prod` command runs database migrations automatically.

After deployment, the backend is available at the service URL Render provides. With the default service name in `render.yaml`, the URL is:

```text
https://zk-fitness-api.onrender.com/api
```

### Step 3: Point the frontend to the backend

The GitHub Pages workflow injects the backend URL into `frontend/config.js` at deploy time.

1. In GitHub, go to **Settings > Secrets and variables > Actions > Variables**.
2. Add a repository variable named `ZK_API_BASE`.
3. Set its value to the deployed backend root URL, for example:
   ```text
   https://zk-fitness-api.onrender.com/api
   ```
4. Redeploy GitHub Pages. Pushes to `main` trigger this automatically.

For local development, leave `ZK_API_BASE` unset. The app falls back to `http://localhost:3000/api`.

### Step 4: Configure CORS and cookies

This step explains what the `CLIENT_ORIGIN` environment variable from Step 2 does. You do **not** set it in a different place.

The backend uses `CLIENT_ORIGIN` to validate incoming requests and to decide how to set cookies. It must be the GitHub Pages origin - the host only, not the full repository path.

| Setting | Example value |
|---|---|
| `CLIENT_ORIGIN` | `https://<username>.github.io` |

Because the frontend and backend are on different origins, the backend sets cookies with `SameSite=None; Secure`. Both sites must use HTTPS, which is the default for both Render and GitHub Pages.

## Troubleshooting

- **Port 3000 already in use**: A previous Node process is still running. Run `npm run dev:stop`, or on Windows use `npx kill-port 3000`.
- **CORS errors in development**: Make sure `NODE_ENV=development` is set (it is by default in `backend/.env.example`). In development, the API reflects the requesting origin.
- **Argon2 not loading**: Ensure you ran `npm install` at the project root; this vendors `frontend/vendor/argon2.min.js`.
- **Portfolio link broken locally**: The "Back to Portfolio" link uses `../index.html`. When you run a local dev server rooted directly in the `frontend/` directory, this link will 404. This is expected; it works correctly on the live GitHub Pages deployment where `frontend/` is a sub-folder of the site root. Serve the project root (e.g., `npx serve .` at the repository root) if you want the link to work locally.

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create a user account |
| POST | `/api/auth/login` | Authenticate and receive a JWT |
| GET | `/api/sync` | Fetch the user's encrypted payload |
| PUT | `/api/sync` | Store a new encrypted payload |

See `backend/server.js` for request/response schemas.

## Security Model

1. The server never receives the user's password or any private key.
2. The client derives deterministic seeds from the password with Argon2id + HKDF, then generates the user's post-quantum keypairs:
   - **ML-DSA-65 signing key**: used to authenticate with the API; the public key is stored server-side, the private key never leaves the browser.
   - **ML-KEM-768 key**: used to encapsulate the per-sync AES data key; the public key is stored server-side, the private key never leaves the browser.
3. The server stores only the public keys and the encrypted blob plus its KEM ciphertext.
4. All transport is encrypted with TLS 1.3.
5. The encrypted payload is opaque to the server and is never logged or inspected.

### Account & Bot Controls

Registration requires solving a server-issued proof-of-work challenge in the browser, which raises the cost for automated account creation. Additional protections include:

- A hidden honeypot field that rejects submissions filled by bots.
- Stricter per-IP rate limiting on registration.
- Optional `REGISTRATION_INVITE_CODE` environment variable to restrict sign-ups on public deployments.
- Account lockout after repeated failed login attempts.

### Known Limitations

- **No offline persistence**: workout data lives in memory; closing the tab without syncing loses unsynced data. IndexedDB/offline caching is on the roadmap.
- **One-time PQC migration**: deployments that used the earlier Argon2id `authKeyHash` scheme must re-run migrations and users must re-register. Old encrypted blobs cannot be decrypted under the new ML-KEM data keys.

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
