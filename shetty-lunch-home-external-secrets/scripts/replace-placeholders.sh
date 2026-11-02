#!/usr/bin/env bash
# Replaces the placeholder YOUR_GITHUB_USERNAME with your real GitHub username in BOTH repos.
# Run once from the project root:   ./scripts/replace-placeholders.sh <your-github-username>
# Windows: run inside WSL2 or Git Bash.
set -euo pipefail
NAME="${1:?usage: $0 <your-github-username>}"
LOWER=$(echo "$NAME" | tr '[:upper:]' '[:lower:]') # container registry paths must be lowercase
cd "$(dirname "$0")/.."

FILES=$(grep -rl "YOUR_GITHUB_USERNAME" --exclude-dir=node_modules --exclude-dir=.git \
        --exclude=README.md --exclude=replace-placeholders.sh . || true)
if [ -z "$FILES" ]; then echo "Nothing to replace - already done."; exit 0; fi

for f in $FILES; do
  sed -i.bak "s/YOUR_GITHUB_USERNAME/${LOWER}/g" "$f" && rm -f "$f.bak"
  echo "updated $f"
done
echo
echo "Done. Registry: ghcr.io/${LOWER}/slh-*   Repos: github.com/${LOWER}/shetty-lunch-home-app and shetty-lunch-home-gitops"
