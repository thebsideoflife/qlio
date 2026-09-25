# Deploying

GitHub Actions minutes on this account are metered. Both deploy workflows still
run on a push to `main` but are debounced so a burst of merges deploys once, and
both can be run from the Actions tab. Each has a local equivalent that uses the
`zeevee` AWS profile, which is the normal way to deploy.

## Deploy from a laptop

Both scripts default to `AWS_PROFILE=zeevee` and `AWS_REGION=us-west-2`; the
OpenTofu backend in `infrastructure/main.tf` hardcodes the `zeevee` profile.

**Backend (Lambdas, API Gateway, tables, FFmpeg image, Remotion function):**

```
./deploy.sh                 # build backend, push FFmpeg image, tofu apply
./deploy.sh --skip-docker   # skip the FFmpeg image when Dockerfile.ffmpeg / stitch / split are unchanged
```

Needs Docker running (unless `--skip-docker`), `tofu` 1.10, Node 20, and
`infrastructure/layers/ffmpeg-layer.zip` (the script builds it with
`build-ffmpeg-layer.sh` if missing). Set `INFRA_TFVARS` to point at a tfvars
file if you use one; the workflow passes none.

**Remotion site (the caption-burning bundle used by exports):**

```
cd zeevee && npm ci && ./deploy-remotion-site.sh
```

`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in GitHub are a long-lived key
for the same account. Locally the `zeevee` profile plays that part; nothing the
workflows use exists only in GitHub.

## What Actions does now

| Workflow | Trigger | Local equivalent |
|---|---|---|
| `Deploy backend` | push to `main` on `backend/**`, `infrastructure/**`, `deploy.sh`, `build-ffmpeg-layer.sh`; or Run workflow | `./deploy.sh` |
| `Deploy Remotion site` | push to `main` on `zeevee/src/remotion/**` and the caption components; or Run workflow | `cd zeevee && ./deploy-remotion-site.sh` |

**Debounce.** Each workflow uses `concurrency: deploy-<name>-<ref>` with
`cancel-in-progress: true` and starts with a `debounce` job that sleeps 120 s,
then checks `git ls-remote origin refs/heads/main`. If `main` has moved on, the
deploy job is skipped and the newer commit's run deploys instead. Manual runs
skip the wait.

One consequence: a push that lands after the sleep window cancels a deploy
that is already running. For the backend that can interrupt `tofu apply`;
re-run the workflow or `./deploy.sh` and tofu reconciles. The FFmpeg image and
layer caches in the workflow are unaffected.

There is no test workflow in this repo, so there is nothing to run on demand;
`npm test` in `backend/` and `zeevee/` are the local checks.
