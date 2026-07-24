/**
 * ZK Fitness — Runtime frontend configuration.
 *
 * This file is intentionally committed with a placeholder so the app works
 * out-of-the-box in local development. For GitHub Pages deployments, the
 * GitHub Actions workflow replaces the placeholder with the production
 * backend URL.
 */
(function () {
  // eslint-disable-next-line no-undef
  if (typeof window !== 'undefined' && !window.ZK_API_BASE) {
    // Default: local development backend. Override for production.
    window.ZK_API_BASE = 'http://localhost:3000/api';
  }
})();
