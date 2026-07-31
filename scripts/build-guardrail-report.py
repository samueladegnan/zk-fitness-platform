#!/usr/bin/env python3
"""Build the guardrail security report page from JSON triage reports.

The v1.1.0 guardrail template renders an interactive dashboard with the
GuardrailReportRenderer. This script reads the JSON reports produced by the
AI CICD Security Guardrail action and injects canonical live/example payloads
into guardrail.html.
"""

import json
import re
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
    """Load a structurally valid guardrail report, including clean reports."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    if not isinstance(data, dict):
        return None
    if not isinstance(data.get("results"), list):
        return None
    if "summary" in data and not isinstance(data["summary"], dict):
        return None
    return data


def combine_reports(reports: list[dict], is_example: bool, is_partial: bool = False) -> dict | None:
    """Combine scope reports for the canonical single-dashboard contract."""
    if not reports:
        return None

    results = [result for report in reports for result in report.get("results", [])]
    summaries = [report.get("summary", {}) for report in reports]
    return {
        "summary": {
            "total": sum(summary.get("total", 0) for summary in summaries) or len(results),
            "high_priority": sum(summary.get("high_priority", 0) for summary in summaries),
            "false_positive": sum(summary.get("false_positive", 0) for summary in summaries),
            "unclear": sum(summary.get("unclear", 0) for summary in summaries),
        },
        "results": results,
        "isExample": is_example,
        "isPartial": is_partial,
    }


def replace_generated_marker(content: str, variable: str, start: str, end: str, value: object) -> str:
    """Replace the value between a stable generated-variable marker pair."""
    value_json = json.dumps(value, indent=2)
    pattern = rf"({re.escape(variable)}\s*=\s*/\*\s*{re.escape(start)}\s*\*/\s*)[\s\S]*?(\s*/\*\s*{re.escape(end)}\s*\*/\s*;)"
    replacement = rf"\g<1>{value_json}\g<2>"
    updated, replacements = re.subn(pattern, replacement, content, count=1)
    if replacements == 0:
        raise RuntimeError(f"Could not find generated marker for {variable}")
    return updated


def build() -> None:
    root = Path(__file__).resolve().parent.parent
    backend_report = load_json_report(root / "backend-guardrail-report.json")
    frontend_report = load_json_report(root / "frontend-guardrail-report.json")

    if backend_report is None:
        backend_report = {**EXAMPLE_BACKEND, "isExample": True}
    else:
        backend_report["isExample"] = False

    if frontend_report is None:
        frontend_report = {**EXAMPLE_FRONTEND, "isExample": True}
    else:
        frontend_report["isExample"] = False

    live_reports = [report for report in (backend_report, frontend_report) if report and not report.get("isExample")]
    example_reports = [EXAMPLE_BACKEND, EXAMPLE_FRONTEND]
    canonical_live_report = combine_reports(
        live_reports,
        is_example=False,
        is_partial=len(live_reports) not in (0, 2),
    )
    canonical_example_report = combine_reports(example_reports, is_example=True)

    guardrail_html = root / "guardrail.html"
    content = guardrail_html.read_text(encoding="utf-8")

    new_content = replace_generated_marker(
        content,
        "window.GUARDRAIL_SECURITY_REPORT",
        "GENERATED_LIVE_REPORT_START",
        "GENERATED_LIVE_REPORT_END",
        canonical_live_report,
    )
    new_content = replace_generated_marker(
        new_content,
        "window.GUARDRAIL_EXAMPLE_REPORT",
        "GENERATED_EXAMPLE_REPORT_START",
        "GENERATED_EXAMPLE_REPORT_END",
        canonical_example_report,
    )

    if new_content == content:
        print(f"{guardrail_html} is already up to date")
        return

    guardrail_html.write_text(new_content, encoding="utf-8", newline="\n")
    print(f"Built {guardrail_html}")


if __name__ == "__main__":
    build()
