#!/usr/bin/env python3
"""Scan source and documentation files for common hardcoded secret patterns."""

import os
import re
import sys

PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|secret|password|token)\s*=\s*[\"'][^\"']{8,}[\"']"),
    re.compile(r"sk_live_[a-zA-Z0-9]{24,}"),
    re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]
EXTENSIONS = {".js", ".json", ".yml", ".yaml", ".env.example", ".md", ".py"}
IGNORED_PARTS = {".git", "node_modules", "site"}


def main() -> int:
    hits = 0
    for root, directories, files in os.walk('.'):
        directories[:] = [directory for directory in directories if directory not in IGNORED_PARTS]
        for filename in files:
            path = os.path.join(root, filename)
            if not any(filename.endswith(extension) for extension in EXTENSIONS):
                continue
            try:
                with open(path, encoding='utf-8', errors='ignore') as handle:
                    for line_number, line in enumerate(handle, 1):
                        if any(pattern.search(line) for pattern in PATTERNS):
                            print(f'{path}:{line_number}: {line.strip()}')
                            hits += 1
            except OSError:
                continue

    if hits:
        print(f'Found {hits} possible secret pattern(s). Review before merging.')
        return 1
    print('No obvious hardcoded secrets detected.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
