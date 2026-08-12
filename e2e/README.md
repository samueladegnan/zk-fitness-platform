# ZK Fitness browser tests

This directory contains Playwright tests for the local trial workflow. They cover starting local mode, creating an empty workout, adding an exercise from the exercise menu, adding an exercise from an exercise detail card, and returning to a plan editor.

They do not cover every browser, account flow, sync failure, corrupted ciphertext, wrong key, expired session, missing key, or two-browser cross-device scenario.

## Run

From the repository root:

```bash
npm ci
npm run install:frontend
npx playwright install chromium
npm run test:e2e
```

The test runner starts the frontend server at `http://localhost:3001` automatically. To use an existing server:

```bash
ZK_E2E_BASE_URL=http://localhost:3001 npm run test:e2e
```

See [the full test instructions](../docs/TESTING.md) for unit tests, integration tests, lint, security checks, Docker, CI mapping, and the scenario matrix.
