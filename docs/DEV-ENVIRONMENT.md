# Dev environment

A full copy of the backend that runs next to production in the same AWS
account (us-west-2), so changes can be tested before they reach users.

## How it works

| | Production | Dev |
|---|---|---|
| Git branch that deploys it | `main` | `dev` |
| Resource name prefix | `zeevee-*` | `qlio-dev-*` |
| OpenTofu workspace | `default` | `dev` |
| Settings file | `infrastructure/envs/prod.tfvars` | `infrastructure/envs/dev.tfvars` |
| Remotion site (caption burn-in) | `zeevee-renderer` | `qlio-dev-renderer` |
| Frontend | Vercel Production | Vercel Preview |

Dev has its own Lambdas, API Gateway URL, S3 buckets, DynamoDB tables,
CloudFront distribution, ECR repo and secrets, with its own state file
(`env:/dev/zeevee/infrastructure.tfstate` in the existing state bucket).
Nothing in dev can read or write production data.

Shared on purpose:

- **Remotion render Lambda** (`remotion-render-4-0-387-…`) and its bucket.
  Renders read clips through presigned URLs, so sharing is safe. Prod alone
  manages the bucket's CORS rules.
- **OpenRouter key**: dev reads prod's `zeevee/openrouter-api-key`.
- **TwelveLabs index**: shared until a dev index exists (see setup step 4).

## The workflow

1. Branch off `dev`, make the change, open a PR **into `dev`**.
2. Merge it. GitHub Actions deploys the backend to dev, and Vercel builds a
   preview of the frontend pointed at the dev API.
3. Test on the dev preview URL.
4. When it's good, open a PR from `dev` into `main`. Merging deploys to prod.

Manual deploys still work: `./deploy.sh --env dev` (or `--env prod`, the
default). For the Remotion bundle: `./zeevee/deploy-remotion-site.sh dev`.

## One-time setup

Done once, by someone with AWS and Vercel access, after this change merges.

1. **Create the `dev` branch** from `main` and push it. GitHub Actions runs the
   first dev deploy: it creates the ECR repo, builds the FFmpeg image and
   creates every dev resource. The first run takes longer than usual.
   (By hand instead: `tofu -chdir=infrastructure init` then
   `./deploy.sh --env dev`.)
2. **Copy secret values into dev**: `./scripts/copy-secrets-to-dev.sh`.
   It copies the TwelveLabs, SporeLabs, API password and showcase keys from
   `zeevee/*` to `qlio-dev/*` without printing them. To give dev a different
   API password, set `qlio-dev/api-password` by hand afterwards.
3. **Point Vercel previews at dev.** Get the dev API URL from the end of the
   deploy log, or `tofu -chdir=infrastructure output -raw api_url` with the
   `dev` workspace selected. In Vercel → Project → Settings → Environment
   Variables, set `VITE_API_URL` for the **Preview** environment to that URL
   (Production keeps the prod URL), then redeploy the `dev` branch preview.
   Every PR preview then talks to dev instead of production.
4. **Optional, for testing TwelveLabs indexing:** create a separate index in
   TwelveLabs with its webhook pointed at `<dev API URL>/webhook`, and set
   `twelve_labs_index_id` in `infrastructure/envs/dev.tfvars`. Until then,
   indexing callbacks for dev uploads go to prod's webhook and are ignored.

## Cost

Dev is pay-per-use like prod (Lambda, DynamoDB on-demand, S3), so an idle dev
environment costs very little: mainly Secrets Manager (about $0.40 per secret
per month) and whatever is stored in its buckets. Test renders and AI calls
cost the same as in prod.
