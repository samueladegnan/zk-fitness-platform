#!/usr/bin/env python3
"""Build a portfolio-ready HTML page from guardrail markdown reports."""

from datetime import datetime, timezone
from html import escape
import os
from pathlib import Path
import re


def load_markdown(path: Path) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8")
    return "*No report generated.*"


def has_findings(md: str) -> bool:
    """Return True if the supplied guardrail markdown actually contains findings."""
    return "### Findings" in md and "No findings to report" not in md


def get_report_or_example(name: str, real_md: str, root: Path) -> tuple[str, bool]:
    """Return the real markdown if it has findings, otherwise fall back to an example.

    The second return value indicates whether the example fallback was used.
    """
    if has_findings(real_md):
        return real_md, False

    example_path = root / "docs" / f"guardrail-example-{name}.md"
    if example_path.exists():
        return example_path.read_text(encoding="utf-8"), True

    return real_md, False


def _inline_to_html(text: str) -> str:
    """Render inline markdown: code, bold, italic, links."""
    # Escape first so literal HTML is safe.
    text = escape(text)
    # Inline code: `code`
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    # Bold: **text**
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    # Italic: *text* (after bold)
    text = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", text)
    # Links: [text](url)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    return text


def md_to_html(md: str) -> str:
    """Convert a small subset of markdown to HTML."""
    lines = md.splitlines()
    html: list[str] = []
    in_list = False
    in_code = False

    for line in lines:
        stripped = line.lstrip()

        if stripped.startswith("```"):
            if in_code:
                html.append("</code></pre>")
                in_code = False
            else:
                html.append("<pre><code>")
                in_code = True
            continue

        if in_code:
            html.append(escape(line))
            continue

        if stripped.startswith("# "):
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append(f"<h2>{_inline_to_html(stripped[2:])}</h2>")
        elif stripped.startswith("## "):
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append(f"<h3>{_inline_to_html(stripped[3:])}</h3>")
        elif stripped.startswith("### "):
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append(f"<h4>{_inline_to_html(stripped[4:])}</h4>")
        elif stripped.startswith("- "):
            if not in_list:
                html.append("<ul>")
                in_list = True
            html.append(f"<li>{_inline_to_html(stripped[2:])}</li>")
        elif stripped == "":
            if in_list:
                html.append("</ul>")
                in_list = False
        else:
            if in_list:
                html.append("</ul>")
                in_list = False
            html.append(f"<p>{_inline_to_html(line)}</p>")

    if in_list:
        html.append("</ul>")
    if in_code:
        html.append("</code></pre>")

    return "\n".join(html)


def main() -> None:
    root = Path(__file__).resolve().parent.parent

    real_backend_md = load_markdown(root / "backend-guardrail-report.md")
    real_frontend_md = load_markdown(root / "frontend-guardrail-report.md")

    backend_md, backend_is_example = get_report_or_example("backend", real_backend_md, root)
    frontend_md, frontend_is_example = get_report_or_example("frontend", real_frontend_md, root)

    backend_html = md_to_html(backend_md)
    frontend_html = md_to_html(frontend_md)

    example_note = (
        '<p class="report-example-note">'
        '<em>Showing an example finding because the last scan returned no real findings.</em>'
        '</p>'
    )
    backend_note = example_note if backend_is_example else ""
    frontend_note = example_note if frontend_is_example else ""

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "samueladegnan/zk-fitness-platform")
    if run_id:
        provenance = f'<a href="{server_url}/{repo}/actions/runs/{run_id}">View run on GitHub</a>'
    else:
        provenance = "Generated locally."

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ZK Fitness | Security Report</title>
  <meta name="description" content="Latest AI CICD Security Guardrail triage report for the ZK Fitness project." />
  <link rel="icon" type="image/svg+xml" href="./assets/favicon.svg" />
  <link rel="stylesheet" href="./assets/css/style.css" />
  <style>
    .report-meta {{ color: #819198; font-size: 0.95rem; margin-bottom: 0.25rem; }}
    .report-credit {{ color: #819198; font-size: 0.85rem; font-style: italic; margin-bottom: 1.5rem; }}
    .report-example-note {{ color: #64748b; font-size: 0.9rem; font-style: italic; margin-bottom: 1rem; }}
    .report-section {{ margin-bottom: 2.5rem; }}
    .report-section h3 {{ margin-top: 1.5rem; }}
    .report-section ul {{ padding-left: 1.25rem; }}
    .report-section li {{ margin-bottom: 0.5rem; }}
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <nav class="site-nav" aria-label="Primary">
    <a class="site-nav-brand" href="./">ZK Fitness</a>
    <ul class="site-nav-links">
      <li><a href="https://samueladegnan.github.io/" target="_blank" rel="noopener noreferrer">&larr; Back to Portfolio</a></li>
      <li><a href="./">Overview</a></li>
      <li><a href="./demo.html">Live Demo</a></li>
      <li><a href="./architecture.html">Architecture</a></li>
      <li><a class="active" href="./guardrail.html" aria-current="page">Security Report</a></li>
      <li>
        <a class="site-nav-github" href="https://github.com/samueladegnan/zk-fitness-platform" aria-label="View source on GitHub">GitHub</a>
      </li>
      <li><a class="btn" href="./frontend/">Launch Live Demo</a></li>
    </ul>
  </nav>

  <header class="page-header">
    <h1 class="project-name">ZK Fitness</h1>
    <p class="project-tagline">Latest AI CICD Security Guardrail triage output for ZK Fitness.</p>
    <a class="btn" href="./frontend/">Launch Live Demo</a>
  </header>

  <main id="main-content" class="main-content">
    <p class="report-meta">Generated: {generated_at} &bull; Tool: <a href="https://github.com/samueladegnan/ai-cicd-security-guardrail">ai-cicd-security-guardrail</a> &bull; {provenance}</p>
    <p class="report-credit">Generated with <a href=\"https://github.com/samueladegnan/ai-cicd-security-guardrail\">ai-cicd-security-guardrail</a>, another project by <a href=\"https://samueladegnan.github.io/\">Samuel Degnan</a>.</p>

    <h2>What This Report Shows</h2>
    <p>Every push to main is scanned with ESLint, the findings are exported as a SARIF report, and the AI CICD Security Guardrail triages them. This page is the raw output of the most recent run, committed automatically by the guardrail workflow so the portfolio always reflects the current state of the codebase.</p>

    <div class="report-section">
      <h2>Backend Report</h2>
      {backend_note}
      {backend_html}
    </div>

    <div class="report-section">
      <h2>Frontend Report</h2>
      {frontend_note}
      {frontend_html}
    </div>
  </main>

  <footer class="site-footer">
    <div class="site-footer__inner">
      <p class="site-footer__tagline">Privacy-first strength &amp; cardio tracking with client-side encryption.</p>
      <p class="site-footer__copyright">&copy; 2026 <a href="https://samueladegnan.github.io/">Samuel Degnan</a></p>
    </div>
  </footer>
</body>
</html>
"""

    output = root / "guardrail.html"
    output.write_text(page, encoding="utf-8")
    print(f"Built {output}")


if __name__ == "__main__":
    main()
