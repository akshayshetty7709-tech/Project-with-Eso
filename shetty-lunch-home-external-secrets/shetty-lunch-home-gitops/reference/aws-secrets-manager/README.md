# Using AWS Secrets Manager instead of Vault (reference, untested here)

1. Create one secret per environment, JSON with the same three keys:
   ```bash
   aws secretsmanager create-secret --name slh/dev --region ap-south-1 \
     --secret-string "{\"DB_USER\":\"slhadmin\",\"DB_PASSWORD\":\"$(openssl rand -base64 24 | tr -d '/+=')\",\"JWT_SECRET\":\"$(openssl rand -hex 32)\"}"
   # repeat for slh/staging and slh/prod with different values
   ```
2. Create an IAM policy from `iam-policy.json`, attach it to an IAM role that trusts the cluster's OIDC provider
   for ServiceAccount `external-secrets/external-secrets` (IRSA), and annotate that ServiceAccount with
   `eks.amazonaws.com/role-arn: <role arn>` (Helm: `--set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=<arn>`).
3. Apply `cluster-secret-store-aws.yaml` instead of `platform/cluster-secret-store.yaml`.
4. Nothing else changes: the ExternalSecrets in `overlays/*/external-secret.yaml` use `key: slh/<env>`,
   which is exactly the Secrets Manager secret name. Same for Azure Key Vault / GCP Secret Manager (change `provider:`).
