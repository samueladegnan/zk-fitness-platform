/**
 * AI-Driven CI/CD Security Guardrail — Security Report Page
 *
 * Loads the latest guardrail reports embedded in guardrail.html and renders
 * them with the shared GuardrailReportRenderer.
 */
(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState !== "loading") {
      fn();
    } else {
      document.addEventListener("DOMContentLoaded", fn);
    }
  }

  function hasFindings(report) {
    return report && Array.isArray(report.results) && report.results.length > 0;
  }

  ready(function () {
    const reports = window.GUARDRAIL_REPORTS || {};
    const backend = reports.backend;
    const frontend = reports.frontend;
    const emptyEl = document.getElementById("security-empty");
    const dashboardEl = document.getElementById("security-dashboard");

    if (hasFindings(backend) || hasFindings(frontend)) {
      if (emptyEl) emptyEl.style.display = "none";
      if (dashboardEl) dashboardEl.style.display = "block";
    } else {
      if (emptyEl) emptyEl.style.display = "block";
      if (dashboardEl) dashboardEl.style.display = "none";
    }

    const timestampEl = document.getElementById("report-timestamp");
    if (timestampEl && reports.timestamp) {
      timestampEl.textContent = reports.timestamp;
    } else if (timestampEl) {
      timestampEl.textContent = "Example data — pending first CI run";
    }

    function renderReport(name, report) {
      const container = document.getElementById(name + "-report");
      const notice = document.getElementById(name + "-example-notice");
      if (!container) return;

      if (notice) {
        notice.style.display = report && report.isExample ? "block" : "none";
      }

      if (hasFindings(report)) {
        const renderer = new GuardrailReportRenderer(container, {
          showChart: true,
          showToolbar: true,
          defaultSort: "severity"
        });
        renderer.render(report);
      } else {
        container.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">⏳</span><h3>' + name + ' report pending</h3><p>The ' + name + ' guardrail report will appear here once the CI pipeline produces it.</p></div>';
      }
    }

    renderReport("backend", backend);
    renderReport("frontend", frontend);
  });
}());
