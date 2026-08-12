#!/usr/bin/env python3
"""Run the repository's ESLint plus Guardrail triage checks locally."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(command, cwd=ROOT):
    print(f"$ {' '.join(command)}")
    return subprocess.run(command, cwd=cwd, check=False)


def eslint_to_sarif(package_dir: str, output_name: str) -> bool:
    package_path = ROOT / package_dir
    raw_path = ROOT / f"{package_dir}-eslint.json"
    eslint = package_path / "node_modules" / ".bin" / ("eslint.cmd" if os.name == "nt" else "eslint")
    if not eslint.exists():
        print(f"ESLint is not installed in {package_dir}. Run npm install there first.", file=sys.stderr)
        return False
    result = run([
        str(eslint),
        ".",
        "--format",
        "json",
        "--output-file",
        str(raw_path),
    ], cwd=package_path)
    if result.returncode != 0 and not raw_path.exists():
        return False

    findings = json.loads(raw_path.read_text(encoding="utf-8"))
    rules = []
    results = []
    for file_result in findings:
        relative = os.path.relpath(file_result["filePath"], ROOT).replace(os.sep, "/")
        for message in file_result.get("messages", []):
            rule_id = message.get("ruleId") or "eslint"
            if rule_id not in rules:
                rules.append(rule_id)
            results.append({
                "ruleId": rule_id,
                "level": "error" if message.get("severity") == 2 else "warning",
                "message": {"text": message.get("message", "ESLint finding")},
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": {"uri": relative},
                        "region": {
                            "startLine": message.get("line", 1),
                            "startColumn": message.get("column", 1),
                        },
                    }
                }],
            })

    sarif = {
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "ESLint",
                    "informationUri": "https://eslint.org/",
                    "rules": [{"id": rule_id} for rule_id in rules],
                }
            },
            "results": results,
        }],
    }
    (ROOT / output_name).write_text(json.dumps(sarif, indent=2) + "\n", encoding="utf-8")
    raw_path.unlink(missing_ok=True)
    return True


def main() -> int:
    if shutil.which("guardrail") is None:
        print("Guardrail CLI is not installed. Install the pinned CI CLI before running this check.", file=sys.stderr)
        print("python -m pip install --disable-pip-version-check https://github.com/samueladegnan/ai-cicd-security-guardrail/archive/refs/tags/v1.1.0.tar.gz", file=sys.stderr)
        return 2

    if not eslint_to_sarif("backend", "backend.sarif"):
        return 1
    if not eslint_to_sarif("frontend", "frontend.sarif"):
        return 1

    provider = os.environ.get("GUARDRAIL_LLM_PROVIDER", "mock")
    commands = [
        ["backend.sarif", "backend-guardrail-report.json", "backend-guardrail-report.md"],
        ["frontend.sarif", "frontend-guardrail-report.json", "frontend-guardrail-report.md"],
    ]
    for input_name, json_name, markdown_name in commands:
        result = run([
            "guardrail",
            str(ROOT / input_name),
            "--format",
            "sarif",
            "--repo-root",
            str(ROOT),
            "--provider",
            provider,
            "--output-json",
            str(ROOT / json_name),
            "--output-markdown",
            str(ROOT / markdown_name),
        ])
        if result.returncode != 0:
            return result.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
