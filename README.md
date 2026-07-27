# Zero-Knowledge Fitness Platform

🌐 **Live Portfolio:** [View the live portfolio &rarr;](https://samueladegnan.github.io/zk-fitness-platform/)

A workout tracker that keeps your training history private. Everything is encrypted on your device before it reaches the server, so your data is readable only by you. Cloud sync and gamified analytics still work because the server only stores opaque, encrypted blobs.

The app also uses post-quantum cryptography (PQC): **ML-DSA-65** for login signatures and **ML-KEM-768** to wrap a fresh AES data key on every sync. That means the system stays secure even as quantum computers improve.

---

## The Problem

Traditional workout apps collect sensitive personal health metrics on centralized servers. That creates several risks:

- **Privacy exposure**: server operators, attackers, or subpoenas can read your health data.
- **Vendor lock-in**: your training history is trapped in proprietary ecosystems.
- **Weak user control**: you cannot easily verify or limit who can read your logs.

## The Solution

This platform flips the trust model. The server only stores **opaque, encrypted payloads** and public keys. Keys are derived from the user's credentials on the client using **Argon2id** and never leave the device. The gamification engine (XP, tonnage, progressive overload) runs entirely on the client on decrypted local data, then re-encrypts state updates for cloud storage.

### Post-Quantum Cryptography

- **ML-DSA-65 (Dilithium)** signs a server-issued nonce during login. The server stores only the user's public key and verifies the signature without ever seeing the private key.
- **ML-KEM-768 (Kyber)** encapsulates a per-sync AES-256-GCM data key. The server stores only the ML-KEM ciphertext; the private key remains client-side.
- **AES-256-GCM** is used for bulk data encryption. AES-256 is already considered quantum-resistant for symmetric cryptography, so the post-quantum layer protects the key exchange and authentication paths.
- **Local mode** does not need PQC: data never leaves the device, so Argon2id-derived AES-256-GCM is sufficient. PQC is only used when you enable cloud sync, where the client must authenticate to the server and protect the per-sync AES key.
- All PQC primitives are provided by `@noble/post-quantum`, a zero-dependency, auditable JavaScript library.

## Key Features

- **Zero-Knowledge, Post-Quantum Privacy**: client-side AES-256-GCM encryption with keys derived via Argon2id; ML-DSA-65 authentication and ML-KEM-768 key encapsulation protect sync and login.
- **Strength & Cardio Tracking**: log weight/reps, distance, duration, heart rate, and calories.
- **Workout Plans & Exercise Database**: reusable templates, custom exercises, and interactive exercise detail pages with records, charts, and a one-rep-max calculator.
- **Active Workout Mode**: live timer, rest timers, warmup sets, mid-workout editing, and persistent state across page navigation.
- **Local Mode**: try the full app instantly without an account; data stays on your device.
- **Cross-Device Sync**: encrypted state syncs across authenticated devices when you enable cloud sync.
- **Progressive Web App**: installable on mobile and desktop with an offline-capable service worker.
- **Gamification**: XP, levels, badges, streaks, personal records, and tonnage tracking computed on the client.

## Architecture

```
───────────────────────────────────────┐
│           Client (Device)            │
│  ┌──────────────────────────────┐    │
│  │  Argon2id key derivation     │    │
│  │  ML-DSA / ML-KEM keypairs    │    │
│  │  AES-256-GCM encrypt/decrypt │    │
│  │  Gamification engine (XP,    │    │
│  │  tonnage, progressive        │    │
│  │  overload analytics)         │    │
│  └──────────────────────────────┘    │
└──────────────┬───────────────────────┘
               │ HTTPS / TLS 1.3
               ▼
┌─────────────────────────────────────┐
│        Node.js / Express API        │
│  • PQC signature auth (ML-DSA-65)   │
│  • Stores only public keys &        │
│    encrypted payloads               │
│  • No access to private keys/data   │
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
| Mobile Wrappers | Capacitor (iOS/Android) |
| Desktop Wrappers | Tauri (Windows/Mac/Linux) |

## Portfolio Ecosystem

This project is part of a larger portfolio of security and DevOps tools:

- **AI CI/CD Security Guardrail**: The `.github/workflows/ai-guardrail.yml` workflow generates an ESLint SARIF report from the actual ZK Fitness codebase and passes it to the reusable `samueladegnan/ai-cicd-security-guardrail@v1.0.0` action. The guardrail triages those findings with a deterministic mock provider by default, or a real LLM when an API key is configured. The latest triage output is committed automatically to `guardrail.html` and shown on the live portfolio as the **Security Report**.

These integrations are documented here and are intended to show how the projects complement each other in a real-world portfolio.

### Enabling Cross-Project Integrations

The guardrail runs in a zero-cost mock mode by default. To upgrade to a real LLM triage, configure the following repository secret in GitHub:

| Secret | Project | Purpose |
|--------|---------|---------|
| `AI_GUARD_PROVIDER` | AI CICD Security Guardrail | LLM provider: `mock` (default), `openai`, `anthropic`, or `gemini`. |
| `AI_GUARD_API_KEY` | AI CICD Security Guardrail | API key for the selected real LLM provider (not needed for `mock`). |

## Quick Start

### Prerequisites

- Node.js >= 20
- npm
- Docker and Docker Compose (for the local Postgres database)

### 1. Clone and install

```bash
git clone https://github.com/samueladegnan/zk-fitness-platform.git
cd zk-fitness-platform
npm install
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

To enable authentication and encrypted sync, deploy the backend to Render with a Neon Postgres database. See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the full walkthrough.

## Troubleshooting

- **Port 3000 already in use**: Run `npm run dev:stop`, or on Windows use `npx kill-port 3000`.
- **CORS errors in development**: Make sure `NODE_ENV=development` is set (it is the default in `backend/.env.example`).
- **Argon2 not loading**: Run `npm install` at the project root to vendor `frontend/vendor/argon2.min.js`.

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
   - **ML-DSA-65 signing key**: used to authenticate with the API; the public key is stored server-side, the private key never leaves the device.
   - **ML-KEM-768 key**: used to encapsulate the per-sync AES data key; the public key is stored server-side, the private key never leaves the device.
3. The server stores only the public keys and the encrypted blob plus its KEM ciphertext.
4. All transport is encrypted with TLS 1.3.
5. The encrypted payload is opaque to the server and is never logged or inspected.

### Account & Bot Controls

Registration requires solving a server-issued proof-of-work challenge on the client, which raises the cost for automated account creation. Additional protections include:

- A hidden honeypot field that rejects submissions filled by bots.
- Stricter per-IP rate limiting on registration.
- Optional `REGISTRATION_INVITE_CODE` environment variable to restrict sign-ups on public deployments.
- Account lockout after repeated failed login attempts.

### Current Status

This is a live portfolio demonstration of a zero-knowledge fitness platform. The web app and PWA are feature-complete and publicly deployed, while the backend can be self-hosted or deployed to Render for testing. Encrypted data is persisted locally with IndexedDB, so workouts survive app restarts and work offline.

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

## Monetization

Billing is optional and completely hidden by default. Local mode is free and includes every workout feature. Cloud sync is the only paid feature, because it is the only part that incurs server costs. See [`docs/MONETIZATION.md`](docs/MONETIZATION.md) for pricing, refund policy, and Stripe setup.

## Release Platforms

ZK Fitness is built as a web-first PWA, so it can be shipped to every major platform with minimal additional configuration.

### Web / PWA (GitHub Pages)

1. Push to `main`.
2. GitHub Actions runs `.github/workflows/pages.yml` and deploys to `https://<username>.github.io/zk-fitness-platform/`.
3. Users visit the site and tap **Add to Home Screen** to install the PWA.

### iOS & Android (Capacitor)

1. Add Capacitor platforms (run once):
   ```bash
   npm install -D @capacitor/cli @capacitor/core @capacitor/ios @capacitor/android
   npx cap add ios
   npx cap add android
   ```
2. Sync the web build into the native projects:
   ```bash
   npx cap sync
   ```
3. Open and publish:
   - **iOS**: `npx cap open ios`, then archive and upload via Xcode to App Store Connect.
   - **Android**: `npx cap open android`, then generate a signed AAB and upload to Google Play Console.

### Desktop (Tauri)

1. Install Rust and the Tauri CLI:
   ```bash
   npm install -D @tauri-apps/cli
   ```
2. Build release artifacts:
   ```bash
   npm run desktop:build
   ```
3. Distribute the generated installers from `src-tauri/target/release/bundle/` (`.dmg`, `.msi`, `.AppImage`, etc.).

### Docker (self-hosted)

1. Build the backend image:
   ```bash
   docker build -t zk-fitness-api ./backend
   ```
2. Push to a registry of your choice, or run locally with the provided `docker-compose.yml`.

## Roadmap

- [x] Offline-first IndexedDB caching.
- [ ] mTLS enforcement between client and API.
- [ ] Audit logging of sync events without exposing payload contents.

## License

MIT © Samuel Degnan
