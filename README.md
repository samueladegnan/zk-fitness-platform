# ZK Fitness

🌐 **Live project:** [samueladegnan.github.io/zk-fitness-platform](https://samueladegnan.github.io/zk-fitness-platform/)

ZK Fitness is a privacy-first strength and cardio tracker. The browser owns the user's keys, plaintext workout data, and analytics. The API stores public key material and encrypted sync payloads, never readable training history.

I built and reviewed this project with AI assistance. I remain responsible for the architecture, security model, implementation decisions, tests, and final code.

## Why it exists

Fitness data is personal, but most tracking products require users to trust a vendor with the raw record. ZK Fitness explores a different boundary: keep the useful product experience while making the server unable to read the training history it stores.

## What is implemented

- Client-side workout logging for strength, cardio, and time-based exercises
- Reusable workout plans, exercise search, custom exercises, history, records, charts, badges, XP, and personal records
- Local mode with encrypted IndexedDB persistence and no account required
- Optional encrypted cloud sync through a Node.js and PostgreSQL API
- Installable PWA with an offline app shell
- Client-side post-quantum authentication and key encapsulation
- Structured backend logging, health checks, rate limits, account lockout, honeypot rejection, and registration proof of work
- CI checks for linting, unit tests, backend integration tests, Docker builds, and automated security triage

## Security boundary

The client derives deterministic key material from the user's password with Argon2id and HKDF. It uses:

- **AES-256-GCM** for the encrypted workout payload
- **ML-DSA-65** to sign a server-issued login nonce
- **ML-KEM-768** to encapsulate a fresh sync data key

The server receives public keys, authentication signatures, and opaque encrypted payloads. It does not receive the password or private keys. Analytics run after client-side decryption.

This is a portfolio implementation, not a claim that application-level cryptography removes every security risk. The browser, password, device, dependencies, and deployment configuration remain part of the trust model.

## Architecture

```text
┌──────────────────────────────┐
│ Browser or installed PWA     │
│                              │
│ Argon2id + HKDF              │
│ ML-DSA-65 and ML-KEM-768     │
│ AES-256-GCM                  │
│ Workout state and analytics  │
└──────────────┬───────────────┘
               │ HTTPS
               ▼
┌──────────────────────────────┐
│ Node.js and Express API      │
│                              │
│ Auth and session cookies      │
│ Encrypted payload validation  │
│ Rate limits and health       │
└──────────────┬───────────────┘
               │
               ▼
        ┌─────────────┐
        │ PostgreSQL  │
        │ opaque data │
        └─────────────┘
```

The [architecture notes](architecture.html) describe the boundary in more detail. The [security report](guardrail.html) shows the automated CI review output and clearly labels illustrative data when a live report is unavailable.

## Technology choices

| Layer | Technology |
| --- | --- |
| Frontend | HTML, CSS, buildless vanilla JavaScript, Web Crypto API |
| Key derivation | Argon2id and HKDF |
| Post-quantum cryptography | ML-DSA-65 and ML-KEM-768 via `@noble/post-quantum` |
| Storage | IndexedDB locally, PostgreSQL for encrypted sync |
| Backend | Node.js, Express, JWT session cookies |
| Operations | Docker, Docker Compose, Render, GitHub Actions |
| Observability | Pino structured logging and database-aware health checks |
| Quality | ESLint, Node test runner, Supertest, Playwright |

The frontend stays buildless on purpose. Native browser APIs and vendored cryptography keep the deployed client small and make the runtime boundary easy to inspect. JSDoc and `jsconfig.json` provide editor and static analysis support without adding a transpiler.

## Try it

Open the [live demo](https://samueladegnan.github.io/zk-fitness-platform/frontend/) and choose **Try without an account**. Local mode keeps the demo self-contained in the browser.

For the guided walkthrough, see the [demo notes](demo.html).

## Local development

### Prerequisites

- Node.js 20 or newer
- npm
- Docker and Docker Compose for the local PostgreSQL service

### Install and run the API

```bash
git clone https://github.com/samueladegnan/zk-fitness-platform.git
cd zk-fitness-platform
npm install
npm run install:backend
cp backend/.env.example backend/.env
npm run dev:infra
npm run migrate
npm start
```

On Windows, copy `backend/.env.example` to `backend/.env` with the equivalent file copy command. The default database settings target the included Docker Compose service.

### Serve the frontend

In a second terminal:

```bash
npm run dev:client
```

Open `http://localhost:3001`. Local mode works without the API. Account registration and cloud sync require the backend and PostgreSQL service.

### Vendored browser assets

The browser loads Argon2 and the post-quantum helper from `frontend/vendor/` so the deployed app can work offline. Rebuild them after updating the related packages:

```bash
npm run copy-argon2
npm run build:pqc
```

### Stop local services

```bash
npm run dev:stop
```

## Quality checks

```bash
npm run test:frontend
npm run test:backend
npm run test:e2e
(cd frontend && npm run lint)
(cd backend && npm run lint)
```

Backend tests expect PostgreSQL. Playwright starts the frontend server automatically and exercises the local trial flow, including adding exercises from cards while editing a workout or plan.

The main CI workflow also runs the backend migration and integration suite against PostgreSQL, builds the backend Docker image, and runs the frontend unit tests. The Pages workflow builds the clean documentation routes under `site/`, which is intentionally ignored because it is generated output.

## Deployments and docs

- [Live demo](demo.html)
- [Architecture notes](architecture.html)
- [OpenAPI specification](docs/openapi.yaml)
- [Backend deployment guide](docs/DEPLOY.md)
- [Automated security report](guardrail.html)
- [GitHub repository](https://github.com/samueladegnan/zk-fitness-platform)

The backend can be deployed to Render with PostgreSQL. See [docs/DEPLOY.md](docs/DEPLOY.md) for environment variables, migrations, CORS, cookies, and release steps.

## Portfolio context

ZK Fitness is part of a small portfolio focused on security boundaries and production operations. The companion projects are the [SEEO AWS Orchestrator](https://samueladegnan.github.io/seeo-aws-orchestrator/) and the [AI CI/CD Security Guardrail](https://samueladegnan.github.io/ai-cicd-security-guardrail/).

## Roadmap

- [x] Offline-first local persistence
- [x] Encrypted sync boundary
- [x] CI security report publication
- [ ] Mutual TLS between independently operated client and API deployments
- [ ] Privacy-preserving sync audit events without payload access

## License

MIT © Samuel Degnan
