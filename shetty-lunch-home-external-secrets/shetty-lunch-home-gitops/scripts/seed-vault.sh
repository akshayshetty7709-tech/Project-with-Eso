#!/usr/bin/env bash
# Writes STRONG RANDOM secrets into Vault, one path per environment:
#     secret/slh/dev      secret/slh/staging      secret/slh/prod      (each: DB_USER, DB_PASSWORD, JWT_SECRET)
# This plays the role of "the security/platform team puts the secret into AWS Secrets Manager / Vault".
# Git never sees these values; the ExternalSecret files in git only contain the PATH.
#
#   ./scripts/seed-vault.sh dev|staging|prod|all
#   FORCE=1 ./scripts/seed-vault.sh dev      overwrite an existing one (see README rotation warning!)
set -euo pipefail
TARGET="${1:?usage: $0 <dev|staging|prod|all>}"
VAULT_TOKEN="${VAULT_TOKEN:-root}"

# Run the vault CLI inside the vault-0 pod. -i lets us pass JSON on stdin.
vexec() { kubectl -n vault exec -i vault-0 -- env VAULT_TOKEN="$VAULT_TOKEN" VAULT_ADDR=http://127.0.0.1:8200 vault "$@"; }

# dev mode normally mounts KV v2 at secret/ already; make sure (no-op if present)
vexec secrets list | grep -q '^secret/' || vexec secrets enable -path=secret kv-v2

seed_env() {
  local env="$1" path="slh/$1" pass jwt
  case "$env" in dev|staging|prod) ;; *) echo "ERROR: unknown environment '$env'"; exit 1;; esac
  if vexec kv get -mount=secret "$path" >/dev/null 2>&1 && [ "${FORCE:-0}" != "1" ]; then
    echo "SKIP  $env: secret/$path already exists (FORCE=1 to overwrite - read the README rotation warning first)"
    return
  fi
  pass=$(openssl rand -base64 24 | tr -d '/+=\n')
  jwt=$(openssl rand -hex 32)
  printf '{"DB_USER":"slhadmin","DB_PASSWORD":"%s","JWT_SECRET":"%s"}' "$pass" "$jwt" \
    | vexec kv put -mount=secret "$path" - >/dev/null
  echo "OK    $env: wrote secret/$path in Vault (values not printed)"
}

if [ "$TARGET" = "all" ]; then
  for e in dev staging prod; do seed_env "$e"; done
else
  seed_env "$TARGET"
fi
