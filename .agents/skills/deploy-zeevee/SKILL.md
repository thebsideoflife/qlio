---
name: deploy-zeevee
description: >
  How Zeevee ships: the frontend (zeevee/) deploys via Vercel when a PR merges
  to main; the backend (backend/ + infrastructure/) deploys by running
  ./deploy.sh from the repo root with the "zeevee" AWS profile in us-west-2.
  There is no GitHub Actions deploy for this repo. Do not invent another
  deploy path.
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
  version: "1.0.0"
---

# Deploying Zeevee

## The contract

| Change touches | How it ships | Verify with |
|---|---|---|
| `zeevee/` (Vite frontend) | **Merge PR to `main`** — Vercel deploys automatically (`zeevee/vercel.json`) | Vercel deployment status / open the production URL |
| `backend/`, `infrastructure/` | **`./deploy.sh`** from the repo root (add `--skip-docker` unless the FFmpeg image changed) | harness MCP `aws_error_summary` / `aws_get_log_events` with `product_id=zeevee`, `region=us-west-2` |
| Both | PR review → merge (frontend goes out via Vercel) → then `./deploy.sh` for the backend | Both of the above |

- Region is always **`us-west-2`**. Profile is always **`zeevee`** (`deploy.sh` defaults both).
- Merging to `main` deploys the **frontend only**. Backend changes do nothing until someone runs `./deploy.sh`.
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

## Known limitation: OpenTofu state is local

`infrastructure/` uses **local state** (`terraform.tfstate`, gitignored — no S3 backend). A fresh clone does not have it, and `tofu apply` without the existing state would try to recreate the whole stack. Before deploying:

```bash
test -f infrastructure/terraform.tfstate && echo "state present" || echo "STATE MISSING"
```

If the state file is missing, **stop and report to the operator** — the deploy must run wherever the state lives until it is migrated to a remote backend. Do not run `tofu apply` (or `deploy.sh`, which calls it) against empty state.

## Backend deploy, step by step

```bash
cd <repo root>
export AWS_SHARED_CREDENTIALS_FILE=/etc/agent-harness/zeevee/aws-credentials
export AWS_CONFIG_FILE=/etc/agent-harness/zeevee/aws-config

# Preflight
aws --profile zeevee sts get-caller-identity
test -f infrastructure/terraform.tfstate || { echo "no tofu state; abort"; exit 1; }

# Deploy (skip the FFmpeg Docker image unless Dockerfile.ffmpeg or stitch code changed)
./deploy.sh --skip-docker
```

`--skip-docker` skips building/pushing the FFmpeg Lambda container image; everything else (backend build, Lambda zips, `tofu apply`) still runs. Only drop the flag when the FFmpeg image itself changed — that path needs Docker available.

## Post-deploy verification

1. Ask harness MCP for errors: `aws_error_summary` with `product_id=zeevee`, `region=us-west-2`, `hours=1`.
2. Tail the specific Lambda you changed: `aws_get_log_events` with `log_group_name=/aws/lambda/<function>` (e.g. `/aws/lambda/zeevee-generate-segments`), same region.
3. Or from the sandbox: `aws --profile zeevee logs tail /aws/lambda/<function> --region us-west-2 --since 15m`.
4. Hit the API if relevant: `https://4bvanrvph5.execute-api.us-west-2.amazonaws.com`.

## Order for mixed changes

1. Open one PR with both frontend and backend changes; get it merged (frontend deploys via Vercel).
2. Run `./deploy.sh --skip-docker` from `main` after the merge so the deployed backend matches what was reviewed.
3. Verify per the section above.

## Related skills

- `merge-triggers-deploy` — the Graided contract; **does not apply here** (Zeevee has no deploy workflows).
- `harness-mcp` — the MCP tools used for post-deploy log checks.
- `aws-as-product` — read-only AWS CLI via `zeevee_dev` assume-role; use for inspection, not deploys.
