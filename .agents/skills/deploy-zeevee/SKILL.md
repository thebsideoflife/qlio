---
name: deploy-zeevee
description: >
  How Zeevee ships: the frontend (zeevee/) deploys via Vercel when a PR merges
  to main; the backend (backend/ + infrastructure/) deploys via GitHub Actions
  (.github/workflows/deploy.yml) on merge, or manually via ./deploy.sh from a
  sandbox.
triggers:
  - deploy
  - ship
  - release
  - vercel
  - backend
  - lambda
  - deploy.sh
license: MIT
metadata:
  author: ColemanIsner
  version: "2.0.0"
---

# Deploying Zeevee

## The contract

| Change touches | How it ships | Verify with |
|---|---|---|
| `zeevee/` (Vite frontend) | **Merge PR to `main`** — Vercel deploys automatically (`zeevee/vercel.json`) | Vercel deployment status / open the production URL |
| `zeevee/src/remotion/**` or `CaptionText.tsx` | **GitHub Actions** (`.github/workflows/deploy-remotion-site.yml`) on merge, or `./zeevee/deploy-remotion-site.sh`. Vercel does **not** update the burn-in bundle. | Re-export a Spanish-toggled project and confirm captions appear |
| `backend/`, `infrastructure/` | **GitHub Actions** (`.github/workflows/deploy.yml`) on merge to `main`, or **`./deploy.sh`** from a sandbox. CI rebuilds the FFmpeg Docker image when `Dockerfile.ffmpeg`, backend lockfile, or the bundled `cutSegments`/`splitVideo` handlers change. | harness MCP `aws_error_summary` / `aws_get_log_events` with `product_id=zeevee`, `region=us-west-2` |
| Both | PR review → merge (frontend goes out via Vercel, backend deploys via GHA) | Both of the above |

- Region is always **`us-west-2`**. Profile is always **`zeevee`** (`deploy.sh` defaults both).
- Merging to `main` deploys **both** frontend (Vercel) and backend (GitHub Actions) automatically.
- Do not run `aws lambda update-function-code`, `sam deploy`, or hand-rolled `tofu apply` invocations — `./deploy.sh` is the single backend deploy path (it builds the backend, packages Lambdas, and runs `tofu apply` in `infrastructure/`).

## Credentials (harness sandboxes)

The harness renders static Zeevee deploy credentials as an AWS profile named `zeevee`, mounted read-only at `/etc/agent-harness/zeevee/`. The sandbox `aws` CLI picks them up automatically. OpenTofu (which `deploy.sh` calls) reads its own environment, so export these before running the script:

```bash
export AWS_SHARED_CREDENTIALS_FILE=/etc/agent-harness/zeevee/aws-credentials
export AWS_CONFIG_FILE=/etc/agent-harness/zeevee/aws-config

aws --profile zeevee sts get-caller-identity   # sanity check first
./deploy.sh --skip-docker
```

If `sts get-caller-identity` fails, the secret `agent-harness/zeevee/aws-credentials` is not populated or not synced — tell the operator (RUNBOOK Step 11c in agent-harness-infra); do not try to work around it.

## OpenTofu state is remote (S3)

State lives in S3 (`zeevee-tfstate-730898501390/zeevee/infrastructure.tfstate`, us-west-2, DynamoDB lock table `zeevee-tflock`) — migrated from local state on 2026-07-02, configured in `infrastructure/main.tf`. Any fresh clone can deploy; there is no state file to look for. The one requirement: run `tofu init` once per clone before `deploy.sh` (the script itself does not init):

```bash
tofu -chdir=infrastructure init -input=false
```

If `init` or `plan` reports a **lock timeout**, another deploy is in flight — wait and retry; never use `-lock=false` or force-unlock without the operator.

## Git identity (sandbox only)

Always run `gh auth setup-git` before any git push in a sandbox. This configures
the correct git credential helper and user identity from the authenticated GitHub
user. **Never hardcode a user email** -- the noreply email format includes a
user ID number that differs per account, and using the wrong ID attributes the
commit to a different user.

```bash
git remote set-url origin https://github.com/ColemanIsner/zeevee.git   # clean URL, no embedded token
gh auth setup-git
```

## Backend deploy, step by step

### Via GitHub Actions (automatic)
Merge a PR touching `backend/` or `infrastructure/` to `main`. The workflow
`.github/workflows/deploy.yml` runs automatically. Requires `AWS_ACCESS_KEY_ID`
and `AWS_SECRET_ACCESS_KEY` set as GitHub Actions secrets on the repo.

### Via sandbox (manual)
```bash
cd <repo root>
git remote set-url origin https://github.com/ColemanIsner/zeevee.git
gh auth setup-git                              # sets correct user identity
export AWS_SHARED_CREDENTIALS_FILE=/etc/agent-harness/zeevee/aws-credentials
export AWS_CONFIG_FILE=/etc/agent-harness/zeevee/aws-config

# Preflight
aws --profile zeevee sts get-caller-identity
tofu -chdir=infrastructure init -input=false

# Deploy (skip the FFmpeg Docker image only when Dockerfile.ffmpeg / cutSegments / splitVideo did not change)
./deploy.sh --skip-docker
```

`--skip-docker` skips building/pushing the FFmpeg Lambda container image; everything else (backend build, Lambda zips, `tofu apply`) still runs. GitHub Actions does the same automatically when those image inputs are unchanged.

## Post-deploy verification

1. Ask harness MCP for errors: `aws_error_summary` with `product_id=zeevee`, `region=us-west-2`, `hours=1`.
2. Tail the specific Lambda you changed: `aws_get_log_events` with `log_group_name=/aws/lambda/<function>` (e.g. `/aws/lambda/zeevee-generate-segments`), same region.
3. Or from the sandbox: `aws --profile zeevee logs tail /aws/lambda/<function> --region us-west-2 --since 15m`.
4. Hit the API if relevant: `https://4bvanrvph5.execute-api.us-west-2.amazonaws.com`.

## Order for mixed changes

1. Open one PR with both frontend and backend changes; get it merged (frontend deploys via Vercel, backend via GitHub Actions). The FFmpeg image rebuilds only when its inputs changed.
2. Verify per the section above.

## Related skills

- `merge-triggers-deploy` — the Graided contract.
- `harness-mcp` — the MCP tools used for post-deploy log checks.
- `aws-as-product` — read-only AWS CLI via `zeevee_dev` assume-role; use for inspection, not deploys.
