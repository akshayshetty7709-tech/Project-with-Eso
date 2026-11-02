#!/usr/bin/env bash
# One-time cluster bootstrap (EXTERNAL SECRETS OPERATOR edition):
#   kind + ingress-nginx + External Secrets Operator + Vault (dev mode, plays "AWS Secrets Manager")
#   + ClusterSecretStore + seeded secrets + ArgoCD + AppProject + root app.
# Run from the GitOps repo root:  ./scripts/bootstrap.sh      Windows: use WSL2 or Git Bash.
set -euo pipefail
cd "$(dirname "$0")/.."

for bin in docker kind kubectl helm openssl; do
  command -v "$bin" >/dev/null || { echo "ERROR: '$bin' is not installed (see README prerequisites)"; exit 1; }
done

if grep -rq "YOUR_GITHUB_USERNAME" argocd overlays base; then
  echo "ERROR: placeholder YOUR_GITHUB_USERNAME is still present."
  echo "       Run ./scripts/replace-placeholders.sh <github-username> from the project root first (README step 2)."
  exit 1
fi

echo ">>> 1/7 Creating kind cluster 'slh' (skipped if it exists)"
if kind get clusters | grep -qx slh; then
  echo "cluster already exists"
else
  kind create cluster --config scripts/kind-config.yaml
fi
kubectl config use-context kind-slh

echo ">>> 2/7 Installing ingress-nginx"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller --timeout=240s

echo ">>> 3/7 Installing External Secrets Operator (namespace external-secrets)"
helm repo add external-secrets https://charts.external-secrets.io >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets --create-namespace --set installCRDs=true --wait --timeout 5m

echo ">>> 4/7 Installing Vault in DEV mode (namespace vault) - in-memory, auto-unsealed, root token 'root'"
helm repo add hashicorp https://helm.releases.hashicorp.com >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install vault hashicorp/vault --namespace vault --create-namespace \
  --set server.dev.enabled=true --set server.dev.devRootToken=root --set injector.enabled=false
kubectl -n vault rollout status statefulset/vault --timeout=300s
kubectl -n vault wait --for=condition=ready pod/vault-0 --timeout=300s

echo ">>> 5/7 Writing random per-environment secrets into Vault"
./scripts/seed-vault.sh all

echo ">>> 6/7 Connecting the cluster to Vault (the 'secret zero' + ClusterSecretStore)"
# "Secret zero": the one credential ESO needs to reach the vault. Practice uses the dev root token.
# Real companies avoid static tokens: Vault Kubernetes auth, or AWS IAM Roles for Service Accounts (see README).
kubectl -n external-secrets create secret generic vault-token --from-literal=token=root \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f platform/cluster-secret-store.yaml
kubectl wait --for=condition=Ready clustersecretstore/vault-backend --timeout=120s

echo ">>> 7/7 Installing ArgoCD, AppProject and the root Application"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deployment/argocd-server --timeout=300s
kubectl -n argocd rollout status deployment/argocd-repo-server --timeout=300s
kubectl apply -f argocd/project.yaml
kubectl apply -f argocd/root-app.yaml

PASS=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d)
cat <<EOF

Done. ArgoCD UI : kubectl -n argocd port-forward svc/argocd-server 8443:443  ->  https://localhost:8443
Username        : admin
Password        : ${PASS}

Hosts file entry:
  127.0.0.1 dev.shettylunchhome.local staging.shettylunchhome.local prod.shettylunchhome.local

Check secrets flowing:  kubectl get externalsecret -A     (STATUS should be SecretSynced)
                        kubectl -n slh-dev get secret slh-secrets
EOF
