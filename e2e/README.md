# ZK Fitness - End-to-End Tests

This directory contains Playwright-based end-to-end tests for the local-trial workout flow.

## Run

```bash
# Install Playwright and browsers (one-time)
npm install
npx playwright install

# Run e2e tests (starts the frontend dev server automatically)
npm run test:e2e
```

Tests run against the frontend served at `http://localhost:3001`.
Set `ZK_E2E_BASE_URL` to point to a different URL, or set it before running
`npx playwright test` directly.
