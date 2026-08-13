# Testing and quality checks

These commands describe the checks available in this repository. Run them from the repository root.

## Install

```bash
npm ci
npm run install:frontend
npm run install:backend
npx playwright install chromium
```

## ZK artifact self-test

Build the circuit artifacts, refresh the browser and backend verification assets, and run a Groth16 proof through the exported verification key:

```bash
npm run zk:build
npm run zk:verify
npm run zk:build:browser
```

The self-test checks the six public signals and verifies a proof. It does not prove that an encrypted blob decrypts to the sensitive workout summary, and it does not cover AES-GCM or ML-KEM internals. The local build script uses a deterministic development contribution so CI can reproduce the artifact. That is not a multi-party trusted setup and is not evidence for a production ceremony.

## Unit tests

Frontend domain and helper tests use Node's built-in test runner:

```bash
npm run test:unit
```

This runs the frontend unit and module integration tests. It covers workout state transitions, fitness calculations, records, statistics, and small crypto helpers.

## Integration tests

Start PostgreSQL first:

```bash
npm run dev:infra
npm run test:integration
```

The backend command runs migrations and the Supertest suites. It uses Node's test force-exit flag because browser-grade Groth16 proving can leave worker resources alive after the assertions finish. The tests cover health and session endpoints, registration validation, challenge-response authentication, proof-bearing encrypted sync storage, payload limits, origin checks, replay rejection, public-signal mutation rejection, and unauthenticated access. The sync fixtures use a valid envelope shape and deterministic byte strings for the KEM field. They test proof validation and opaque storage, not a real client-side decapsulation flow.

## End-to-end tests

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright starts the static frontend server on port 3001. The current browser suite covers local trial startup, creating an empty workout, adding an exercise from the exercise menu, adding an exercise from its detail card, and returning to a plan editor.

To run against an existing server:

```bash
ZK_E2E_BASE_URL=http://localhost:3001 npm run test:e2e
```

## Lint

```bash
npm run lint
```

This runs ESLint for the frontend and backend.

## Security checks

Dependency audit:

```bash
npm run security:audit
```

This command runs the backend and frontend audits independently and fails when either package reports a moderate or higher vulnerability. CI runs the same command and fails on a non-zero audit result.

Secret pattern scan:

```bash
npm run security:secrets
```

This runs the same repository scan used by the security workflow. It searches tracked source and documentation file types for common hardcoded secret patterns. It is not a complete secret detector.

Automated triage report:

```bash
npm run security:guardrail
```

This command requires the Guardrail CLI used by CI and produces report files in the repository root. The committed security page labels illustrative data when a live report is unavailable. The report is an automated review aid, not an independent security assessment.

## Lint and tests together

```bash
npm run check
```

## Static Pages build

```bash
npm run build:pages
```

This writes generated Pages output to `site/`. The directory is ignored by Git.

## Docker startup

Create a strong local-only JWT secret before starting the API container:

```bash
export JWT_SECRET=$(node -e 'console.log(require("crypto").randomBytes(64).toString("hex"))')
export CLIENT_ORIGIN="http://localhost:3001"
docker compose up --build
```

The Compose stack starts PostgreSQL, waits for its health check, runs migrations, and starts the API on port 3000 in development mode. Its HTTP-only cookie can be used by the HTTP frontend on port 3001. In another terminal, serve the frontend with:

```bash
npm run dev:client
```

Stop the stack with:

```bash
docker compose down
```

## CI mapping

| Check | Local command | Workflow |
| --- | --- | --- |
| Frontend lint | `cd frontend && npm run lint` | `.github/workflows/ci.yml` |
| Backend lint | `cd backend && npm run lint` | `.github/workflows/ci.yml` |
| Frontend tests | `npm run test:frontend` | `.github/workflows/ci.yml` |
| ZK artifact self-test | `npm run zk:verify` | `.github/workflows/ci.yml` |
| Browser and backend ZK assets | `npm run zk:build:browser` | `.github/workflows/ci.yml` |
| Backend migration and tests | `npm run test:backend` | `.github/workflows/ci.yml` |
| Playwright | `npm run test:e2e` | `.github/workflows/ci.yml` |
| Docker image build | `docker build -t zk-fitness-api ./backend` | `.github/workflows/ci.yml` |
| Runtime dependency audit | `npm run security:audit` | `.github/workflows/ci.yml` and `.github/workflows/ai-guardrail.yml` |
| Secret pattern scan | `npm run security:secrets` | `.github/workflows/ai-guardrail.yml` |
| Guardrail report | `npm run security:guardrail` | `.github/workflows/ai-guardrail.yml` |

## Scenario matrix

| Scenario | Implemented behavior | Current test evidence | Gap |
| --- | --- | --- | --- |
| Offline mode | Local mode works without an account. The service worker caches the static app shell and skips API requests. | Playwright local trial flow | No dedicated offline network test |
| IndexedDB persistence | Encrypted records are saved, loaded, and deleted by the IndexedDB helper. | App path uses the helper | No dedicated IndexedDB test |
| Corrupted ciphertext | AES-GCM rejects modified authenticated ciphertext. | Frontend crypto unit test | No browser persistence corruption test |
| Invalid workout proof | The API rejects malformed proof data, invalid public signals, or verification failure. | Proof-bearing backend sync fixtures and mutation rejection test | No adversarial browser proof mutation test |
| Wrong key | AES-GCM or ML-KEM decryption fails before state is returned. | Frontend crypto unit test covers the AES-GCM path | No browser KEM decapsulation failure test |
| Expired session | JWT verification returns HTTP 401 for an invalid or expired session. | Unauthenticated session and sync tests | Expiry is not isolated |
| Failed sync | The client keeps local state and reports unavailable cloud sync. | Fallback code path | No dedicated network-failure test |
| Missing key | Decryption stops when the required KEM key pair is unavailable. | Error path in `app.js` | No dedicated missing-key test |
| Cross-device sync | The API verifies a proof bound to the encrypted blob and KEM ciphertext, stores the ciphertext, and returns proof metadata. | Backend sync lifecycle tests | No two-browser test or conflict resolution |

## Latest review results

These results were run from the current checkout on August 11, 2026. The backend checks used PostgreSQL 16 in Docker. The browser checks used Chromium installed by Playwright.

| Check | Result |
| --- | --- |
| Frontend lint | Passed |
| Frontend unit tests | Passed, 113 tests |
| Backend migration and integration tests | Passed, 22 tests |
| Groth16 artifact self-test | Passed, six public signals verified |
| ZK circuit build | Passed |
| Browser and backend ZK asset build | Passed |
| Playwright local UI tests | Passed, 4 tests |
| Pages build | Passed |
| Secret-pattern scan | Passed, no obvious hardcoded secrets |
| Backend and frontend runtime audits | Passed, 0 vulnerabilities |
| Backend Docker image build | Passed |
| Docker Compose validation and migration | Passed |
| Root development-tree audit | Not clean. The ZK development toolchain reports 15 low-severity advisories through `circomlibjs`, `ethers`, and `elliptic` |

The root development-tree audit is intentionally not described as clean. The current root audit reports 15 low-severity advisories through the ZK build toolchain, including `circomlibjs`, `ethers`, and `elliptic`. They are outside the backend runtime image, but they remain part of the developer dependency graph and should be removed or explicitly accepted before making a full-repository audit claim.

## What these checks do not prove

Passing tests and lint do not prove browser coverage beyond the tested paths, cryptographic correctness beyond the tested paths, resistance to a compromised device or dependency, or operational reliability.
