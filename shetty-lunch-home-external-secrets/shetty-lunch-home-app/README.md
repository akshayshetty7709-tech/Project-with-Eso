# Shetty Lunch Home — application repo

Source code, Dockerfiles, docker-compose and the CI pipeline for the Shetty Lunch Home food-delivery platform.

* Run locally: `docker compose up --build` → http://localhost:8080
* CI: `.github/workflows/ci.yml` (test → scan → build & push to ghcr.io → bump the dev image tag in the GitOps repo)
* The Kubernetes manifests and ArgoCD config live in the **`shetty-lunch-home-gitops`** repo.

The full step-by-step guide (what to change, how to deploy, practice scenarios, troubleshooting) is in the
README at the root of the project zip.
