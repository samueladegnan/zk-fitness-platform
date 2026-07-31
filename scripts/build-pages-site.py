#!/usr/bin/env python3
"""Build the static GitHub Pages site with clean, extensionless URLs.

Source pages at the repository root (demo.html, architecture.html, guardrail.html)
are transformed into directory indexes:

- site/index.html
- site/demo/index.html
- site/architecture/index.html
- site/security/index.html

Asset references are rewritten so they resolve correctly from each page's new
location. The production backend URL is injected into site/frontend/config.js.
"""

import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

SITE_DIR = Path('site')
PAGES = ['index', 'demo', 'architecture', 'security']
PUBLIC_ROUTES = {
    'demo': './demo/',
    'architecture': './architecture/',
    'security': './security/',
}


def rewrite_documentation_links(content: str, prefix: str = './') -> str:
    """Rewrite source-relative documentation links to generated clean routes."""
    route_prefix = prefix.rstrip('/')
    for source_page, public_route in PUBLIC_ROUTES.items():
        source_name = 'guardrail' if source_page == 'security' else source_page
        route_name = public_route.removeprefix('./')
        destination = f'{route_prefix}/{route_name}'
        content = content.replace(f'href="./{source_name}.html"', f'href="{destination}"')
        content = content.replace(f'href="./{route_name}"', f'href="{destination}"')
    return content


def rewrite_root(content: str) -> str:
    """Rewrite links inside the root index.html to point to clean subpage URLs."""
    return rewrite_documentation_links(content)


def rewrite_subpage(content: str) -> str:
    """Rewrite links inside a subpage so assets and cross-links go up one level."""
    content = re.sub(r'(href|src)="\./assets/', r'\1="../assets/', content)
    content = re.sub(r'href="\./frontend/', 'href="../frontend/', content)
    content = rewrite_documentation_links(content, prefix='../')
    return content.replace('href="./"', 'href="../"')


def build(api_base: str = 'http://localhost:3000/api') -> None:
    if SITE_DIR.exists():
        shutil.rmtree(SITE_DIR)
    SITE_DIR.mkdir(parents=True)

    # Static assets and the app bundle are copied as-is.
    shutil.copytree('assets', SITE_DIR / 'assets', dirs_exist_ok=True)
    shutil.copytree('frontend', SITE_DIR / 'frontend', dirs_exist_ok=True)

    # Build each portfolio page into its directory index.
    for page in PAGES:
        source_page = 'guardrail' if page == 'security' else page
        src = Path(f'{source_page}.html')
        if not src.exists():
            continue

        content = src.read_text(encoding='utf-8')
        if page == 'security':
            timestamp = datetime.now(timezone.utc).strftime('%B %d, %Y at %H:%M UTC')
            content = content.replace(
                'Published with the Pages build.',
                f'Published with the Pages build on {timestamp}.',
            )
        if page == 'index':
            content = rewrite_root(content)
            dest = SITE_DIR / 'index.html'
        else:
            content = rewrite_subpage(content)
            dest = SITE_DIR / page / 'index.html'
            dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding='utf-8')

    # Inject the production backend URL into the frontend config.
    config_path = SITE_DIR / 'frontend' / 'config.js'
    config = config_path.read_text(encoding='utf-8')
    config = config.replace(
        "window.ZK_API_BASE = 'http://localhost:3000/api';",
        f"window.ZK_API_BASE = '{api_base}';",
    )
    config_path.write_text(config, encoding='utf-8')


if __name__ == '__main__':
    api_base = os.environ.get('ZK_API_BASE', 'http://localhost:3000/api')
    build(api_base)
