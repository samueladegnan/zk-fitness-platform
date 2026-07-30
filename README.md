# Zero-Knowledge Fitness Platform

🌐 **Live Portfolio:** [samueladegnan.github.io/zk-fitness-platform](https://samueladegnan.github.io/zk-fitness-platform/)

A workout tracker that keeps your training history private. Your data is encrypted on your device before it reaches the server, so only you can read it. The server stores only opaque, encrypted blobs.

The app uses post-quantum cryptography: **ML-DSA-65** for login signatures and **ML-KEM-768** to wrap a fresh AES data key on every sync. The symmetric bulk encryption is AES-256-GCM, with keys derived from your password via Argon2id.

---

## The Problem

Most workout apps upload your health data to a centralized server. That exposes you to breaches, subpoenas, and vendor lock-in.

## The Solution

This platform shifts trust to the client. The server stores only public keys and encrypted blobs. Keys are derived from your password with **Argon2id** and never leave your device. XP, tonnage, and other analytics run locally on decrypted data, which is then re-encrypted for cloud sync.

### Post-Quantum Cryptography

- **ML-DSA-65** signs a server-issued nonce during login; only the public key is stored server-side.
- **ML-KEM-768** encapsulates a per-sync AES-256-GCM data key; the server stores only the ciphertext.
- **AES-256-GCM** protects the encrypted payload itself.
- **Local mode** skips PQC entirely because data never leaves the device.
- All PQC primitives come from `@noble/post-quantum`, a zero-dependency, auditable JavaScript library.

## Key Features

- **Zero-Knowledge, Post-Quantum Privacy**: client-side AES-256-GCM encryption with Argon2id-derived keys; ML-DSA-65 authentication and ML-KEM-768 key encapsulation for sync.
- **Workout Logging & Planning**: log strength and cardio sessions, build reusable workout plans, browse a custom exercise database, view records, charts, and one-rep-max estimates.
- **Offline-First Client Architecture**: buildless vanilla-JS SPA with IndexedDB persistence, service worker caching, and state that survives app restarts.
- **Local Mode**: try the full app without an account; data stays on your device.
- **Cross-Device Sync**: encrypted state syncs across authenticated devices.
- **Progressive Web App**: installable on mobile and desktop with an offline service worker.

## Architecture

```
───────────────────────────────────────┐
│           Client (Device)            │
│  ┌──────────────────────────────┐    │
│  │  Argon2id key derivation     │    │
│  │  ML-DSA / ML-KEM keypairs    │    │
│  │  AES-256-GCM encrypt/decrypt │    │
│  │  Workout tracking &          │    │
│  │  analytics engine            │    │
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

## Type Safety

This project uses **vanilla JavaScript** with **JSDoc type annotations** and a `jsconfig.json` that enables `checkJs`. This is a deliberate choice:

- The app targets the browser's native Web Crypto API, WebAssembly, and PWA surface directly, so a buildless stack keeps the runtime footprint tiny.
- JSDoc + `checkJs` gives us static type coverage, IntelliSense, and CI-grade validation without adding a transpiler or bundler.
- If a future team prefers TypeScript, the JSDoc annotations map directly to `.ts` files with minimal migration cost.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML5, Vanilla JavaScript, Web Crypto API |
| Key Derivation | Argon2id (via vendored `argon2-browser`) |
| Post-Quantum Crypto | ML-DSA-65, ML-KEM-768 (via `@noble/post-quantum`) |
| Symmetric Encryption | AES-256-GCM |
| Backend | Node.js, Express, JSON Web Tokens |
| Database | PostgreSQL 16 |
| Observability | Pino structured logging, DB-aware `/api/health` |
| Container | Docker, Docker Compose |
| CI/CD | GitHub Actions |
| Mobile Wrappers | Capacitor (iOS/Android) |
| Desktop Wrappers | Tauri (Windows/Mac/Linux) |

## Portfolio Ecosystem

- **AI CI/CD Security Guardrail**: `.github/workflows/ai-guardrail.yml` generates an ESLint SARIF report from the ZK Fitness codebase and triages it with `samueladegnan/ai-cicd-security-guardrail@v1.1.0`. The latest output is committed to `guardrail.html` and shown as the **Security Report**. When the scan finds real issues, those are displayed; when no issues are found, example placeholders are shown so the dashboard is never empty.

### Enabling Cross-Project Integrations

The guardrail uses a zero-cost mock provider by default. To use a real LLM, set these repository secrets:

| Secret | Purpose |
|--------|---------|
| `AI_GUARD_PROVIDER` | LLM provider: `mock` (default), `openai`, `anthropic`, or `gemini`. |
| `AI_GUARD_API_KEY` | API key for the selected real LLM provider (not needed for `mock`). |

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

For full request/response schemas, see [`docs/openapi.yaml`](docs/openapi.yaml).

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

The app provides a complete, user-friendly workout tracking experience:

- **Active Workout**: live workout timer, set logging, auto-generated warmup sets, and the ability to add or edit exercises and sets mid-workout.
- **Plans & History**: create reusable workout templates, edit or delete past workouts, and review your full training history.
- **Exercise Database**: browse built-in exercises or add custom ones with category and equipment metadata.
- **Records & Analytics**: view personal records, progress charts, and one-rep-max estimates computed locally on your device.

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
