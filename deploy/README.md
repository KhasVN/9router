# Deploy the maintained gateway

Source: [KhasVN/9router](https://github.com/KhasVN/9router). Images: [khasvn/9router](https://hub.docker.com/r/khasvn/9router). This repository is standalone and has no dependency on `auranion-config`.

## Source and updates

```bash
git clone --branch auranion https://github.com/KhasVN/9router.git
```

Run subsequent commands from the cloned repository root. See [maintenance notes](../AURANION.md) for patch inventory and upstream updates.

`master` mirrors upstream. `auranion` holds downstream fixes and publishes tested images. Daily sync opens reviewable merge PRs. Conflicts produce draft PRs. Nothing auto-merges or deploys. Use merge commits to retain upstream ancestry.

[Upstream sync](https://github.com/KhasVN/9router/actions/workflows/auranion-sync.yml) and [container builds](https://github.com/KhasVN/9router/actions/workflows/auranion-ci.yml) also support manual runs.

## Deployment

The supplied Compose configuration is for a new installation. It does not replace an existing gateway or migrate its data. Before upgrading an existing installation, back up its database and retain its volume mappings, secrets and tunnel configuration. Never run `docker compose down --volumes` against production data.

Copy `deploy/.env.example` to `deploy/.env` only if the latter does not exist. Fill every required value. Use independent strong random values for the dashboard password, session signing secret, API-key secret and machine identity salt. `.env` files are excluded from Git and the Docker build context. Do not paste secrets into issues or logs.

Set `NINEROUTER_IMAGE` to the tested manifest digest from the successful container workflow, not a floating tag. CI publishes Linux AMD64 and ARM64 only after both real-image checks pass. `latest`, `auranion` and commit tags can move; digests identify the artifact exactly.

Validate without printing resolved secrets:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
```

For an intentional new deployment:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
```

Dashboard: http://127.0.0.1:20128/dashboard. API: http://127.0.0.1:20128/v1. Set `NINEROUTER_PORT` if that host port is occupied. Create provider connections, combos and a client API key in the authenticated dashboard.

Named volumes retain application data and home state when the container is replaced. Keep the Compose project name stable to reuse them. Environment changes do not reset an already-stored dashboard password.

The host port binds only to loopback. A host-running cloudflared tunnel can target `http://127.0.0.1:20128`. A tunnel running in another container needs a shared network and the gateway service address instead. No tunnel is installed or changed by this configuration. Set `AUTH_COOKIE_SECURE=true` when dashboard access is exclusively HTTPS.

## Verification boundary

The offline suite covers packed SSE events, split Unicode, terminal events, native Claude JSON and truncated-stream rejection. The Docker smoke test drives the real production HTTP server with isolated CommandCode and Responses fixtures, then checks authentication and persisted configuration after container replacement.

Fixture checks make no paid inference calls and cannot establish production provider availability or Cloudflare latency. Public gateway timeouts need production request/provider evidence; successful path normalization alone does not prove inference works.
