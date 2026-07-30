#!/usr/bin/env python3
"""Build the guardrail security report page from JSON triage reports.

The v1.1.0 guardrail template renders interactive dashboards with the
GuardrailReportRenderer. This script reads the JSON reports produced by the
AI CICD Security Guardrail action and injects them into guardrail.html as the
window.GUARDRAIL_REPORTS data structure.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path


EXAMPLE_BACKEND = {
    "summary": {"total": 1, "high_priority": 0, "false_positive": 0, "unclear": 1},
    "results": [
        {
            "finding": {
                "rule_id": "generic-error-handler",
                "message": "Generic error handler may leak stack traces in production.",
                "file_path": "backend/server.js",
                "line": 0,
                "column": 0,
                "severity": "LOW",
                "code_snippet": "// Example finding shown when the real scan returns no findings.",
                "cwe": "CWE-209",
                "tool": "eslint",
                "language": "javascript",
            },
            "verdict": "UNCLEAR",
            "confidence": 0.6,
            "reasoning": "Example finding for demonstration purposes. The real guardrail scan has not yet produced a report.",
            "compliance_hits": [],
            "remediation": "Log the full error server-side and return a generic message to the client in production builds.",
        }
    ],
}

EXAMPLE_FRONTEND = {
    "summary": {"total": 1, "high_priority": 0, "false_positive": 0, "unclear": 1},
    "results": [
        {
            "finding": {
                "rule_id": "no-console",
                "message": "console.log statement left in production code.",
                "file_path": "frontend/app.js",
                "line": 0,
                "column": 0,
                "severity": "LOW",
                "code_snippet": "// Example finding shown when the real scan returns no findings.",
                "cwe": None,
                "tool": "eslint",
                "language": "javascript",
            },
            "verdict": "UNCLEAR",
            "confidence": 0.6,
            "reasoning": "Example finding for demonstration purposes. The real guardrail scan has not yet produced a report.",
            "compliance_hits": [],
            "remediation": "Remove the statement or replace it with a structured logging utility that respects log levels.",
        }
    ],
}


def load_json_report(path: Path) -> dict | None:
    """Load a guardrail JSON report if it exists and is valid."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        return data
    except (json.JSONDecodeError, OSError):
        return None


def build() -> None:
    root = Path(__file__).resolve().parent.parent
    backend_report = load_json_report(root / "backend-guardrail-report.json")
    frontend_report = load_json_report(root / "frontend-guardrail-report.json")

    if backend_report is None or not backend_report.get("results"):
        backend_report = {**EXAMPLE_BACKEND, "isExample": True}
    else:
        backend_report["isExample"] = False

    if frontend_report is None or not frontend_report.get("results"):
        frontend_report = {**EXAMPLE_FRONTEND, "isExample": True}
    else:
        frontend_report["isExample"] = False

    reports = {
        "backend": backend_report,
        "frontend": frontend_report,
        "timestamp": datetime.now(timezone.utc).strftime("%B %d, %Y at %H:%M UTC"),
    }

    guardrail_html = root / "guardrail.html"
    content = guardrail_html.read_text(encoding="utf-8")

    # Replace the embedded window.GUARDRAIL_REPORTS assignment with the live data.
    reports_json = json.dumps(reports, indent=2)
    content = re.sub(
        r"window\.GUARDRAIL_REPORTS\s*=\s*\{[\s\S]*?\};",
        "window.GUARDRAIL_REPORTS = " + reports_json + ";",
        content,
        count=1,
    )


    guardrail_html.write_text(content, encoding="utf-8", newline="\n")
    print(f"Built {guardrail_html}")


if __name__ == "__main__":
    build()
