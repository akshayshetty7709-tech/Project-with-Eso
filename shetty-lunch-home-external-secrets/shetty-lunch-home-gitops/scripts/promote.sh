#!/usr/bin/env bash
# Promote the image tag from one environment to the next by editing git (never kubectl).
#   ./scripts/promote.sh dev staging
#   ./scripts/promote.sh staging prod
# Afterwards: create a branch, commit, open a pull request. Merge = promotion.
set -euo pipefail
FROM="${1:?usage: $0 <from-env> <to-env>   e.g. $0 dev staging}"
TO="${2:?usage: $0 <from-env> <to-env>}"
cd "$(dirname "$0")/.."

for e in "$FROM" "$TO"; do
  [ -f "overlays/$e/kustomization.yaml" ] || { echo "ERROR: overlays/$e/kustomization.yaml not found"; exit 1; }
done

TAG=$(grep -m1 -E '^[[:space:]]+newTag:' "overlays/$FROM/kustomization.yaml" | awk '{print $2}')
[ -n "$TAG" ] || { echo "ERROR: could not read newTag from overlays/$FROM"; exit 1; }
if [ "$TAG" = "latest" ]; then
  echo "ERROR: $FROM is still on 'latest'. Let CI deploy a real sha-xxxxxxx tag to dev first."; exit 1
fi

sed -i.bak -E "s/^([[:space:]]+newTag:).*/\1 ${TAG}/" "overlays/$TO/kustomization.yaml"
rm -f "overlays/$TO/kustomization.yaml.bak"

echo "Promoted ${TAG}: ${FROM} -> ${TO}"
echo
echo "Next:"
echo "  git checkout -b promote-${TO}-${TAG}"
echo "  git add overlays/${TO}/kustomization.yaml"
echo "  git commit -m \"promote ${TAG} to ${TO}\""
echo "  git push -u origin promote-${TO}-${TAG}   # then open a pull request, get it approved, merge"
