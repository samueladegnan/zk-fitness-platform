/**
 * AI Guardrail — Security Report Page
 *
 * Renders the combined ZK Fitness backend/frontend self-assessment with the
 * same state transitions and single dashboard mount as the canonical report.
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

  function setDisplay(id, display) {
    const element = document.getElementById(id);
    if (element) element.style.display = display;
  }

  function setText(id, text) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  }

  function setStatus(text, isExample) {
    const statusLabel = document.querySelector(".report-status-label");
    if (!statusLabel) return;
    const dotClass = isExample ? "status-dot status-dot--example" : "status-dot";
    statusLabel.innerHTML = '<span class="' + dotClass + '" aria-hidden="true"></span> ' + text;
  }

  function showExampleNotice(reason) {
    setDisplay("security-example-notice", "block");
    setDisplay("security-live-findings", "none");

    if (reason === "clean") {
      setDisplay("security-live-success", "block");
      setText("security-example-label", "Example dashboard · live scan clean");
      setText("security-example-title", "Example findings are shown below");
      setText(
        "security-example-copy",
        "The real Guardrail scan found no issues in this repository. The dashboard below uses committed synthetic data to demonstrate how findings are presented; these example findings are not real repository issues."
      );
      setStatus("Live scan clean · example dashboard", true);
    } else {
      setDisplay("security-live-success", "none");
      setText("security-example-label", "Example dashboard · live scan unavailable");
      setText("security-example-title", "Illustrative findings are shown below");
      setText(
        "security-example-copy",
        "The live CI report is not available in this build, so this page is showing committed synthetic data to demonstrate the dashboard. Every finding below is sample data and is not a real issue in this repository."
      );
      setStatus("Illustrative example report", true);
    }
  }

  function showLiveFindings(isMixed) {
    setDisplay("security-example-notice", isMixed ? "block" : "none");
    setDisplay("security-live-success", "none");
    setDisplay("security-live-findings", "block");
    setDisplay("security-empty", "none");
    if (isMixed) {
      setText("security-example-label", "Partial report · unavailable scope");
      setText("security-example-title", "Live findings are shown below");
      setText(
        "security-example-copy",
        "One or more report scopes were unavailable in this build. The dashboard below shows the available live results; synthetic findings are not being presented for the unavailable scope."
      );
    }
    setStatus(isMixed ? "Partial live scan · unavailable scope" : "Live backend/ and frontend/ self-assessment", isMixed);
  }

  function showEmptyState(message) {
    setDisplay("security-example-notice", "none");
    setDisplay("security-live-success", "none");
    setDisplay("security-live-findings", "none");
    setDisplay("security-dashboard", "none");
    setDisplay("security-empty", "block");
    if (message) setText("security-empty-copy", message);
  }

  function showExampleFailureAfterCleanScan() {
    showEmptyState();
    setText("security-empty-title", "The real Guardrail scan found no issues");
    setText(
      "security-empty-copy",
      "The live scan is clean, but the committed example dashboard could not be loaded in this build. No example findings are being shown; please retry after the next Pages build."
    );
    setStatus("Live scan clean · example unavailable", true);
  }

  function showExampleFailureAfterUnavailableScan() {
    showEmptyState();
    setText("security-empty-title", "Security report unavailable");
    setText(
      "security-empty-copy",
      "The live Guardrail scan and the committed example dashboard could not be loaded in this build. Please retry after the next Pages build or explore the illustrative browser demo."
    );
    setStatus("Security report unavailable", true);
  }

  function render(report, isExample, exampleReason, isMixed) {
    const results = report && Array.isArray(report.results) ? report.results : null;
    const dashboardEl = document.getElementById("security-dashboard");

    if (!results) {
      if (isExample && exampleReason === "clean") {
        showExampleFailureAfterCleanScan();
      } else {
        showExampleFailureAfterUnavailableScan();
      }
      return;
    }

    setDisplay("security-empty", "none");
    if (isExample) {
      showExampleNotice(exampleReason);
    } else {
      showLiveFindings(isMixed);
    }
    if (!dashboardEl) return;

    dashboardEl.style.display = "block";
    const renderer = new GuardrailReportRenderer(dashboardEl, {
      showChart: true,
      showToolbar: true,
      defaultSort: "severity"
    });
    renderer.render(report);
  }

  ready(function () {
    const liveReport = window.GUARDRAIL_SECURITY_REPORT;
    const exampleReport = window.GUARDRAIL_EXAMPLE_REPORT;
    const isMixed = Boolean(liveReport && liveReport.isPartial);

    if (liveReport && liveReport.results.length > 0) {
      render(liveReport, false, null, isMixed);
      return;
    }

    if (exampleReport) {
      render(exampleReport, true, liveReport ? "clean" : "unavailable");
      return;
    }

    if (liveReport) {
      showExampleFailureAfterCleanScan();
      return;
    }

    showExampleFailureAfterUnavailableScan();
  });
}());
