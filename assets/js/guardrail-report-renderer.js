/**
 * GuardrailReportRenderer — Reusable report dashboard
 *
 * A vanilla-JS component that renders a guardrail triage report as an
 * interactive dashboard: summary counts, Chart.js doughnut, filter/sort
 * toolbar, and expandable findings table.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else if (typeof define === "function" && define.amd) {
    define([], factory);
  } else {
    root.GuardrailReportRenderer = factory();
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DEFAULT_OPTIONS = {
    showChart: true,
    showToolbar: true,
    defaultSort: "severity",
    onRowClick: null,
    emptyMessage: "No findings match the current filters.",
  };

  let instanceCounter = 0;

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str).replace(/[&<>"']/g, function (m) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
    });
  }

  function severityRank(severity) {
    const map = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
    return map[severity] || 0;
  }

  function languageFromPath(path) {
    const ext = (path || "").split(".").pop()?.toLowerCase();
    const map = {
      c: "c", cpp: "c", h: "c", rb: "ruby", js: "javascript", ts: "javascript",
      py: "python", tf: "hcl", java: "java", go: "go", rs: "rust"
    };
    return map[ext] || "clike";
  }

  class GuardrailReportRenderer {
    constructor(container, options) {
      this.container = typeof container === "string" ? document.querySelector(container) : container;
      if (!this.container) {
        throw new Error("GuardrailReportRenderer: container not found");
      }

      this.options = { ...DEFAULT_OPTIONS, ...(options || {}) };
      this.id = "gr-report-" + (++instanceCounter);
      this.report = null;
      this.currentFilter = "all";
      this.currentSearch = "";
      this.currentSort = this.options.defaultSort || "severity";
      this.chartInstance = null;
      this.results = [];

      this._scaffold();
      this._bindControls();
    }

    _element(name) {
      return document.getElementById(this.id + "-" + name);
    }

    _scaffold() {
      this.container.innerHTML = [
        '<div class="summary-card" id="' + this.id + '-summary">',
        '  <div class="summary-header">',
        '    <div>',
        '      <h3 class="summary-title">Executive Summary</h3>',
        '      <p class="summary-subtitle">Guardrail triage results</p>',
        '    </div>',
        '    <div id="' + this.id + '-ci-verdict" class="ci-verdict-badge"></div>',
        '  </div>',
        '  <div class="summary-metrics">',
        '    <div class="metric-card metric-total" role="button" tabindex="0" data-verdict="all" aria-label="Show all findings">',
        '      <span class="metric-value" data-metric="total">0</span>',
        '      <span class="metric-label">Total</span>',
        '    </div>',
        '    <div class="metric-card metric-high" role="button" tabindex="0" data-verdict="HIGH_PRIORITY" aria-label="Filter by High Priority">',
        '      <span class="metric-value" data-metric="high">0</span>',
        '      <span class="metric-label">High Priority</span>',
        '    </div>',
        '    <div class="metric-card metric-fp" role="button" tabindex="0" data-verdict="FALSE_POSITIVE" aria-label="Filter by False Positive">',
        '      <span class="metric-value" data-metric="fp">0</span>',
        '      <span class="metric-label">False Positive</span>',
        '    </div>',
        '    <div class="metric-card metric-unclear" role="button" tabindex="0" data-verdict="UNCLEAR" aria-label="Filter by Unclear">',
        '      <span class="metric-value" data-metric="unclear">0</span>',
        '      <span class="metric-label">Unclear</span>',
        '    </div>',
        '  </div>',
        this.options.showChart ?
        '  <p class="chart-title">Verdict distribution</p>' +
        '  <div class="chart-wrap">' +
        '    <canvas id="' + this.id + '-chart" aria-label="Verdict distribution chart" role="img"></canvas>' +
        '  </div>' : "",
        '</div>',

        '<div class="results-card" id="' + this.id + '-results">',
        this.options.showToolbar ?
        '  <div class="results-toolbar">' +
        '    <div class="filter-group">' +
        '      <label for="' + this.id + '-filter" class="sr-only">Filter by verdict</label>' +
        '      <select id="' + this.id + '-filter">' +
        '        <option value="all">All verdicts</option>' +
        '        <option value="HIGH_PRIORITY">High Priority</option>' +
        '        <option value="FALSE_POSITIVE">False Positive</option>' +
        '        <option value="UNCLEAR">Unclear</option>' +
        '      </select>' +
        '    </div>' +
        '    <div class="search-group">' +
        '      <label for="' + this.id + '-search" class="sr-only">Search findings</label>' +
        '      <input type="search" id="' + this.id + '-search" placeholder="Search rule, CWE, file, or message…" />' +
        '    </div>' +
        '    <div class="sort-group">' +
        '      <label for="' + this.id + '-sort" class="sr-only">Sort by</label>' +
        '      <select id="' + this.id + '-sort">' +
        '        <option value="severity" ' + (this.currentSort === "severity" ? "selected" : "") + '>Sort: Severity</option>' +
        '        <option value="confidence" ' + (this.currentSort === "confidence" ? "selected" : "") + '>Sort: Confidence</option>' +
        '        <option value="location" ' + (this.currentSort === "location" ? "selected" : "") + '>Sort: Location</option>' +
        '      </select>' +
        '    </div>' +
        '  </div>' +
        '  <p class="table-hint">Click any row to expand reasoning, remediation, and code context.</p>' : "",
        '  <div class="results-table-wrap">',
        '    <table class="guardrail-table">',
        '      <thead>',
        '        <tr>',
        '          <th scope="col">Location</th>',
        '          <th scope="col">Rule / CWE</th>',
        '          <th scope="col">Compliance</th>',
        '          <th scope="col">Verdict</th>',
        '          <th scope="col">Confidence</th>',
        '        </tr>',
        '      </thead>',
        '      <tbody id="' + this.id + '-body"></tbody>',
        '    </table>',
        '  </div>',
        '</div>'
      ].join("");

      this.summaryCard = this._element("summary");
    }

    _bindControls() {
      const self = this;
      if (this.options.showToolbar) {
        const filterSelect = this._element("filter");
        const searchInput = this._element("search");
        const sortSelect = this._element("sort");

        if (filterSelect) {
          filterSelect.addEventListener("change", function (e) {
            self.setVerdictFilter(e.target.value);
          });
        }

        if (searchInput) {
          searchInput.addEventListener("input", function (e) {
            self.currentSearch = e.target.value;
            self._applyFilters();
          });
        }

        if (sortSelect) {
          sortSelect.addEventListener("change", function (e) {
            self.currentSort = e.target.value;
            self._applyFilters();
          });
        }
      }

      const metricCards = this.container.querySelectorAll(".metric-card");
      metricCards.forEach(function (card) {
        const verdict = card.dataset.verdict;
        const applyAction = function () { self.setVerdictFilter(verdict, true); };
        card.addEventListener("click", applyAction);
        card.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            applyAction();
          }
        });
      });
    }

    static normalizeReport(report) {
      if (!report) return null;
      const summary = report.summary || {
        total: 0,
        high_priority: 0,
        false_positive: 0,
        unclear: 0
      };

      const results = (report.results || []).map(function (r) {
        const finding = r.finding || r;
        return {
          filePath: finding.file_path || finding.filePath || "",
          line: finding.line || 0,
          column: finding.column || 0,
          ruleId: finding.rule_id || finding.ruleId || "unknown",
          cwe: finding.cwe || "",
          severity: finding.severity || "MEDIUM",
          message: finding.message || "",
          verdict: r.verdict || "UNCLEAR",
          confidence: typeof r.confidence === "number" ? r.confidence : 0,
          reasoning: r.reasoning || "",
          remediation: r.remediation || "",
          snippet: finding.code_snippet || finding.snippet || "",
          language: finding.language || "",
          tool: finding.tool || "",
          complianceHits: r.compliance_hits || r.complianceHits || []
        };
      });

      return {
        summary: {
          total: summary.total || results.length,
          high_priority: summary.high_priority || results.filter(function (r) { return r.verdict === "HIGH_PRIORITY"; }).length,
          false_positive: summary.false_positive || results.filter(function (r) { return r.verdict === "FALSE_POSITIVE"; }).length,
          unclear: summary.unclear || results.filter(function (r) { return r.verdict === "UNCLEAR"; }).length
        },
        results: results
      };
    }

    render(report) {
      this._originalReport = report;
      this.report = GuardrailReportRenderer.normalizeReport(report);
      this.results = this.report.results;

      this._updateSummary(this.report.summary);
      if (this.options.showChart) {
        this._renderChart(this.report.summary);
      }
      this.setVerdictFilter("all", false);

      this.container.classList.add("fade-in");
    }

    _updateSummary(summary) {
      const totalEl = this.container.querySelector('[data-metric="total"]');
      const highEl = this.container.querySelector('[data-metric="high"]');
      const fpEl = this.container.querySelector('[data-metric="fp"]');
      const unclearEl = this.container.querySelector('[data-metric="unclear"]');

      if (totalEl) totalEl.textContent = summary.total;
      if (highEl) highEl.textContent = summary.high_priority;
      if (fpEl) fpEl.textContent = summary.false_positive;
      if (unclearEl) unclearEl.textContent = summary.unclear;

      const ciBadge = this._element("ci-verdict");
      if (summary.high_priority > 0) {
        ciBadge.textContent = "CI: Fail";
        ciBadge.className = "ci-verdict-badge ci-fail";
        ciBadge.title = "Build would fail because high-priority risks remain.";
      } else {
        ciBadge.textContent = "CI: Pass";
        ciBadge.className = "ci-verdict-badge ci-pass";
        ciBadge.title = "Build would pass; no high-priority risks detected.";
      }
    }

    _renderChart(summary) {
      const ctx = this._element("chart");
      if (!ctx || typeof Chart === "undefined") return;

      if (this.chartInstance) {
        this.chartInstance.destroy();
      }

      this.chartInstance = new Chart(ctx, {
        type: "doughnut",
        data: {
          labels: ["High Priority", "False Positive", "Unclear"],
          datasets: [
            {
              data: [summary.high_priority, summary.false_positive, summary.unclear],
              backgroundColor: ["#ef4444", "#10b981", "#f59e0b"],
              borderWidth: 0,
              hoverOffset: 8
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: (event, elements) => {
            if (elements && elements.length > 0) {
              const labelsMap = { 0: "HIGH_PRIORITY", 1: "FALSE_POSITIVE", 2: "UNCLEAR" };
              this.setVerdictFilter(labelsMap[elements[0].index], true);
              this._scrollToResults();
            }
          },
          plugins: {
            legend: { position: "bottom", labels: { padding: 16, usePointStyle: true } }
          },
          animation: { animateScale: true, animateRotate: true }
        }
      });
    }

    _scrollToResults() {
      const resultsEl = this._element("results");
      if (resultsEl) {
        resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    setVerdictFilter(verdict, toggle) {
      if (toggle && this.currentFilter === verdict) {
        verdict = "all";
      }
      this.currentFilter = verdict;

      const filterSelect = this._element("filter");
      if (filterSelect) filterSelect.value = verdict;

      this.container.querySelectorAll(".metric-card").forEach(function (card) { card.classList.remove("active"); });
      const activeCard = this.container.querySelector('.metric-card[data-verdict="' + verdict + '"]');
      if (activeCard) activeCard.classList.add("active");

      this._applyFilters();
    }

    _sortItems(items, sortKey) {
      const copy = [].concat(items);
      if (sortKey === "confidence") {
        return copy.sort(function (a, b) { return b.confidence - a.confidence; });
      }
      if (sortKey === "location") {
        return copy.sort(function (a, b) { return (a.filePath || "").localeCompare(b.filePath || ""); });
      }
      return copy.sort(function (a, b) { return severityRank(b.severity) - severityRank(a.severity); });
    }

    _applyFilters() {
      let items = [].concat(this.results);

      if (this.currentFilter !== "all") {
        items = items.filter(function (i) { return i.verdict === this.currentFilter; }.bind(this));
      }
      if (this.currentSearch.trim()) {
        const q = this.currentSearch.toLowerCase();
        items = items.filter(function (i) {
          return [i.ruleId, i.cwe, i.filePath, i.message].some(function (field) {
            return (field || "").toLowerCase().includes(q);
          });
        });
      }

      items = this._sortItems(items, this.currentSort);
      this._renderTable(items);
    }

    _renderVerdictBadge(verdict) {
      const map = {
        HIGH_PRIORITY: ["High Priority", "verdict-high"],
        FALSE_POSITIVE: ["False Positive", "verdict-fp"],
        UNCLEAR: ["Unclear", "verdict-unclear"]
      };
      const m = map[verdict] || [verdict, "verdict-unclear"];
      return '<span class="guardrail-badge ' + m[1] + '">' + escapeHtml(m[0]) + '</span>';
    }

    _renderComplianceHits(hits) {
      if (!hits || !hits.length) return "<em class='muted'>None</em>";
      return hits.map(function (h) {
        return '<span class="guardrail-badge badge-control" title="' + escapeHtml(h.description || "") + '">' + escapeHtml(h.framework) + ': ' + escapeHtml(h.rule_id || h.ruleId || "") + '</span>';
      }).join(" ");
    }

    _renderTable(items) {
      const tbody = this._element("body");
      tbody.innerHTML = "";

      if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5"><em class="muted">' + escapeHtml(this.options.emptyMessage) + '</em></td></tr>';
        return;
      }

      const self = this;
      items.forEach(function (item, idx) {
        const row = document.createElement("tr");
        row.innerHTML = [
          '<td class="finding-loc">' + escapeHtml(item.filePath || "-") + '<br><small>line ' + (item.line || "-") + (item.column ? ":" + item.column : "") + '</small></td>',
          '<td><code>' + escapeHtml(String(item.ruleId)) + '</code><br><small class="cwe-label">' + escapeHtml(item.cwe || "-") + '</small></td>',
          '<td>' + self._renderComplianceHits(item.complianceHits) + '</td>',
          '<td class="verdict-cell">' + self._renderVerdictBadge(item.verdict) + '</td>',
          '<td><div class="confidence-bar" style="--value:' + Math.round(item.confidence * 100) + '%"></div><small>' + Math.round(item.confidence * 100) + '%</small></td>'
        ].join("");

        const detailRow = document.createElement("tr");
        detailRow.className = "detail-row";
        const langClass = languageFromPath(item.filePath);
        const locationText = escapeHtml(item.filePath || "-") + " — line " + (item.line || "-") + (item.column ? ":" + item.column : "");
        const verdictLabel = item.verdict === "HIGH_PRIORITY" ? "High Priority" : item.verdict === "FALSE_POSITIVE" ? "False Positive" : "Unclear";
        detailRow.innerHTML = [
          '<td colspan="5">',
          '  <div class="detail-content">',
          '    <div class="detail-header">',
          '      <div>',
          '        <h4 class="detail-location">' + locationText + '</h4>',
          '        <p class="detail-rule"><code>' + escapeHtml(String(item.ruleId)) + '</code> · ' + escapeHtml(item.cwe || "No CWE") + '</p>',
          '      </div>',
          '      <button type="button" class="detail-close" aria-label="Close details">Close</button>',
          '    </div>',
          '    <div class="detail-grid">',
          '      <div class="detail-col detail-reasoning">',
          '        <div class="detail-block">',
          '          <h4>Message</h4>',
          '          <p>' + escapeHtml(item.message || "-") + '</p>',
          '        </div>',
          '        <div class="detail-block">',
          '          <h4>Reasoning</h4>',
          '          <p>' + escapeHtml(item.reasoning) + '</p>',
          '        </div>',
          '        <div class="detail-block">',
          '          <h4>Remediation</h4>',
          '          <p>' + escapeHtml(item.remediation) + '</p>',
          '        </div>',
          '      </div>',
          '      <div class="detail-col detail-context">',
          '        <div class="detail-block">',
          '          <h4>Finding Details</h4>',
          '          <p><strong>Verdict:</strong> ' + escapeHtml(verdictLabel) + ' · <strong>Confidence:</strong> ' + Math.round(item.confidence * 100) + '%</p>',
          '          <p><strong>Severity:</strong> ' + escapeHtml(item.severity || "-") + ' · <strong>Line:</strong> ' + (item.line || "-") + '</p>',
          '          <p><strong>Tool:</strong> ' + escapeHtml(item.tool || "-") + ' · <strong>Language:</strong> ' + escapeHtml(item.language || "-") + '</p>',
          '        </div>',
          item.snippet ? '<div class="detail-block"><h4>Code Context</h4><pre><code class="language-' + langClass + '">' + escapeHtml(item.snippet) + '</code></pre></div>' : '<div class="detail-block"><h4>Code Context</h4><p class="muted">No source snippet available for this finding.</p></div>',
          '        <div class="detail-block">',
          '          <h4>Compliance Controls</h4>',
          item.complianceHits.length ? self._renderComplianceHits(item.complianceHits) : "<p class='muted'>None mapped</p>",
          '        </div>',
          '      </div>',
          '    </div>',
          '  </div>',
          '</td>'
        ].join("");
        detailRow.style.display = "none";
        detailRow.id = self.id + "-detail-" + idx;
        row.setAttribute("tabindex", "0");
        row.setAttribute("role", "button");
        row.setAttribute("aria-expanded", "false");
        row.setAttribute("aria-controls", detailRow.id);
        row.style.cursor = "pointer";

        const toggleRow = function () {
          const showing = detailRow.style.display === "none";
          detailRow.style.display = showing ? "table-row" : "none";
          row.setAttribute("aria-expanded", String(showing));
          if (showing) {
            if (typeof window !== "undefined" && window.Prism) {
              window.Prism.highlightAllUnder(detailRow);
            }
            if (typeof self.options.onRowClick === "function") {
              self.options.onRowClick(item, { row: row, detailRow: detailRow });
            }
          }
        };

        const closeBtn = detailRow.querySelector(".detail-close");
        if (closeBtn) {
          closeBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            detailRow.style.display = "none";
            row.setAttribute("aria-expanded", "false");
          });
        }

        row.addEventListener("click", toggleRow);
        row.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleRow();
          }
        });

        tbody.appendChild(row);
        tbody.appendChild(detailRow);
      });
    }

    destroy() {
      if (this.chartInstance) {
        this.chartInstance.destroy();
        this.chartInstance = null;
      }
      this.container.innerHTML = "";
    }
  }

  return GuardrailReportRenderer;
}));
