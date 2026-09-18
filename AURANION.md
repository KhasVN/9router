# Auranion-maintained 9router

Fork: https://github.com/KhasVN/9router

Images: https://hub.docker.com/r/khasvn/9router

## Branches and updates

- `master` mirrors `decolua/9router` without downstream commits.
- `auranion` is the default and release branch. Keep local fixes in small commits.
- Daily and manual **Auranion upstream sync** fast-forwards the mirror, then opens one merge PR at a time.
- Conflicts produce a draft PR. Resolve on its branch, never overwrite downstream changes or force-push shared history.
- Sync explicitly dispatches **Auranion container**, because bot events alone may not start checks.
- Merge upstream PRs with **Create a merge commit**, not squash or rebase. This retains upstream ancestry.
- Nothing auto-merges or deploys. Merge only after reviewing changes and both architecture checks.
- GitHub can disable schedules after repository inactivity. A manual run and re-enabling the workflow restores them.

## Downstream changes

- CommandCode pre-read replays raw bytes, preserving packed tool deltas, Unicode and terminal events.
- Claude forced-stream JSON fallback uses the ordinary Message converter instead of Chat Completions JSON.
- Missing/failed upstream completion returns an error rather than successful partial output.
- Docker uses official npm and Alpine registries. Inherited upstream publishing jobs are gated to their original repository.

Keep regression checks when upstream implements equivalent fixes; remove redundant patches only after verification.

## Verification and publishing

```bash
node --test tests/commandcode-claude-regression.test.mjs
```

```bash
docker build -t 9router:test .
```

```bash
node tests/docker-smoke.mjs 9router:test
```

The smoke check uses the real production entrypoint, HTTP routes, SQLite, authentication, executors and translators. A Docker-internal network blocks external provider traffic. It checks Claude Messages, duplicated `/v1/v1/messages`, native Responses, Unicode tool calls, JSON fallback, truncated/failed streams, and persistence after container replacement. Only uniquely named test containers, network and volume are removed.

The CI matrix builds and runs each image natively on Linux AMD64 and ARM64. Only successfully tested images are pushed. After both pass, a manifest receives `sha-<full-commit>`, `auranion` and `latest` tags. Tags are mutable registry references; pin the manifest digest for reproducible deployment. A rerun may resolve newer upstream dependencies because upstream does not track a lockfile.

Docker Hub credentials live only in encrypted repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. Pull-request jobs never receive those credentials. Rotate the PAT in Docker Hub and update the secret before its expiry.

This fork is standalone. [Deployment configuration](deploy/README.md) lives in this repository; no `auranion-config` submodule is needed. Publishing an image does not upgrade any running gateway. Public-provider latency, credentials, routing and Cloudflare behavior are not proven by fixture tests.
