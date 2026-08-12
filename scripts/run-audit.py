#!/usr/bin/env python3
"""Run dependency audits for both package roots without hiding failures."""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    statuses = {}
    for package_dir in ("backend", "frontend"):
        npm = "npm.cmd" if os.name == "nt" else "npm"
        command = [npm, "audit", "--audit-level=moderate"]
        print(f"$ {' '.join(command)}  # {package_dir}")
        result = subprocess.run(command, cwd=ROOT / package_dir, check=False)
        statuses[package_dir] = result.returncode

    for package_dir, status in statuses.items():
        print(f"{package_dir} audit exit code: {status}")
    return 0 if all(status == 0 for status in statuses.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
