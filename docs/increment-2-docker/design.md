# Increment 2 — Docker image + pnpm (design)

Date: 2026-07-14. Status: approved by user after brainstorming.
Context: see `docs/overview.md`. Increment 1 shipped the server/CLI/MCP (`main` @ e3d8523+).

## What & why

Two coupled changes:

1. **A lightweight multiarch Docker image for the server** (linux/amd64 + linux/arm64),
   published to GHCR on every `main` push — so spawning/handling the server is one
   `docker run`, state lives in one named volume, and Windows-host firewall friction is
   replaced by an explicit Docker port mapping.
2. **Repo-wide pnpm adoption** — one package manager everywhere (dev, CI, Docker), with the
   Docker builder exploiting pnpm's lockfile-only `fetch` layer for fast cached rebuilds.

## Decisions log (from brainstorming)

| Question | Decision |
|---|---|
| Registry/trigger | GHCR (`ghcr.io/omnith/agentphone`), publish on `main` pushes; PRs build without pushing |
| Base image | `node:22-slim` multi-stage (Approach A) — better-sqlite3 glibc prebuilds for both arches, no QEMU-emulated C++ compile; ~180MB final. Alpine rejected (musl = source builds, 5-15 min arm64 legs); distroless rejected (no shell breaks admin-via-exec) |
| Package manager | pnpm, repo-wide (not Docker-only — two lockfiles would drift). Pinned via exact-version `packageManager` field + corepack (ships with Node 22) |
| Tags | `latest` + `sha-<short>` on main |
| Arch support | linux/amd64 (Windows box via Docker Desktop/WSL2), linux/arm64 (MacBook) |

## Deliverables

### 1. pnpm switch

- `package.json`: add `"packageManager": "pnpm@<exact 10.x version current at implementation>"`
  (corepack requires an exact semver, not a range); scripts unchanged.
- Delete `package-lock.json`; generate `pnpm-lock.yaml` (`corepack enable; pnpm install`).
- CI: `actions/setup-node` with `cache: pnpm`, `corepack enable`, `pnpm install --frozen-lockfile`,
  `pnpm run build/typecheck/lint`, `pnpm test`.
- README: dev + agent install paths become `corepack enable` →
  `pnpm install && pnpm run build && pnpm link --global`.
- All local gates must pass identically under pnpm before the Docker work starts.

### 2. Dockerfile (multi-stage, `node:22-slim`)

```dockerfile
# builder
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch                          # lockfile-only layer: caches until deps change
COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm run build \
 && pnpm prune --prod                   # virtual store is inside node_modules -> copyable

# runtime
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    AGENTPHONE_BIND=0.0.0.0 \
    AGENTPHONE_DB=/data/agentphone.db \
    AGENTPHONE_EVENTS=/data/agentphone.events.jsonl
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data /app
USER node
VOLUME /data
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4747/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/agentphone.js"]
CMD ["serve"]
```

Notes: `AGENTPHONE_BIND=0.0.0.0` is mandatory inside a container (host exposure is then
governed solely by the `-p` mapping). Non-root `node` user. The entrypoint/cmd split means
`docker run --rm -v agentphone:/data ghcr.io/omnith/agentphone admin invite` runs admin
commands against the same volume, and `docker exec agentphone node dist/agentphone.js admin …`
works on a live container.

- `.dockerignore`: `node_modules`, `dist`, `.git`, `docs`, `assets`, `*.db*`, `*.jsonl`,
  `coverage`, `.github`.

### 3. Compose file

`docker-compose.yml` at repo root: the published image, `4747:4747`, named volume
`agentphone-data:/data`, `restart: unless-stopped`. One `docker compose up -d` server.

### 4. CI publish job

Appended to `.github/workflows/ci.yml`:

- New `docker` job: `needs: test`, runs on ubuntu-latest.
- Steps: checkout → QEMU (`docker/setup-qemu-action`) → buildx (`docker/setup-buildx-action`)
  → GHCR login (`docker/login-action` with `GITHUB_TOKEN`; job gets `packages: write`)
  → metadata (`docker/metadata-action`: tags `latest` on main + `sha-<short>`)
  → `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`,
  `push: ${{ github.ref == 'refs/heads/main' }}`, GHA layer cache (`cache-from/to: type=gha`).
- **Image smoke (amd64, before any push):** load the amd64 image, `docker run -d` it, poll
  `/api/health` until healthy, run one `admin invite` via a second `docker run` sharing the
  volume, assert the invite code prints. Fail the job (and thus the push) if the smoke fails.

### 5. README

New "Server — Docker (recommended)" block placed above the from-source path:

```bash
docker run -d --name agentphone -p 4747:4747 -v agentphone:/data \
  ghcr.io/omnith/agentphone:latest
docker exec agentphone node dist/agentphone.js admin invite --name volumi
```

plus the compose alternative and a one-line note that the port mapping replaces per-exe
Windows firewall rules. From-source instructions switch to pnpm.

## Error handling / operational notes

- Bind failure inside the container surfaces via the existing `startServer` reject (increment 1
  M2 fix) → container exits non-zero → visible in `docker ps`/restart policy.
- Healthcheck marks the container unhealthy if `/api/health` stops answering.
- SQLite on a named volume: single-writer semantics unchanged (one server container per volume;
  admin one-shots share it briefly — same as the host-mode admin story).
- Image contains no tokens; secrets remain env/volume concerns of the operator.

## Testing strategy

- No `src/` changes → no new unit tests. Existing 70-test suite must stay green under pnpm.
- CI is the verification surface: (a) full gate matrix under pnpm on both OSes, (b) the amd64
  image smoke (healthcheck + admin invite) gating every publish.
- Manual acceptance: `docker compose up -d` on the Windows box; register an agent from the
  MacBook against `http://100.110.150.142:4747`; exchange one message.

## Non-goals

- No Windows/arm containers, no alpine/distroless variants, no image signing/SBOM, no
  auto-versioned release tags (only `latest` + `sha-*`), no Fly.io deployment (future
  increment — this image is its natural input), no pnpm workspace restructuring.

## Acceptance criteria

1. `pnpm install --frozen-lockfile` + all four gates + build pass locally and in CI on both
   OS matrices; `package-lock.json` is gone.
2. CI publishes a working multiarch image to `ghcr.io/omnith/agentphone` (`latest`, `sha-*`)
   on main pushes only; PR runs build (and smoke) without pushing.
3. `docker run -d -p 4747:4747 -v agentphone:/data ghcr.io/omnith/agentphone:latest` yields a
   healthy container serving `/api/health`; `admin invite` works via exec and via one-shot run
   sharing the volume.
4. The CI image smoke (health + invite) gates the publish.
5. README documents the Docker-first server path and the pnpm dev/agent paths accurately
   (cold-verifiable).
