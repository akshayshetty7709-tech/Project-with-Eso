# Shetty Lunch Home — GitOps repo

Desired state of the cluster. ArgoCD watches this repo; nobody applies manifests by hand (except the one-time bootstrap).

* `base/` – manifests shared by all environments (Postgres, 4 services, frontend, ingress)
* `overlays/dev|staging|prod` – namespace, image tags, replicas, hostname (prod also has HPA + PDB)
* `argocd/` – AppProject, root app (app-of-apps) and one Application per environment
* `scripts/bootstrap.sh` – kind cluster + ingress-nginx + ArgoCD + project + root app
* `scripts/promote.sh dev staging` – promote the image tag to the next environment (then open a PR)

The CI pipeline in the **`shetty-lunch-home-app`** repo rewrites the image tags in `overlays/dev/kustomization.yaml`.
The full step-by-step guide is in the README at the root of the project zip.

**External Secrets edition:** no Secret in git. `scripts/bootstrap.sh` installs ESO + Vault, seeds random secrets (`scripts/seed-vault.sh`), applies `platform/cluster-secret-store.yaml` and starts ArgoCD. The overlays contain `external-secret.yaml` files that only name the Vault path. Details: section 9 of the root README.
