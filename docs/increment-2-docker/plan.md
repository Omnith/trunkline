# agentphone Docker + pnpm Implementation Plan (Increment 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a lightweight multiarch (amd64+arm64) Docker image of the agentphone server published to GHCR on main pushes, with the repo switched to pnpm end-to-end, per `docs/increment-2-docker/design.md`.

**Architecture:** Repo-wide pnpm (exact-pinned via corepack) first, so dev/CI/Docker share one lockfile; then a `node:22-slim` multi-stage Dockerfile exploiting `pnpm fetch` for a lockfile-only cache layer; a CI `docker` job that smoke-tests the amd64 image (health + admin invite) before any multiarch push to `ghcr.io/omnith/agentphone`.

**Tech Stack:** pnpm 10 + corepack, Docker buildx + QEMU, docker/build-push-action v6, GHCR, node:22-slim.

**Conventions (from project CLAUDE.md — apply in every task):**
- Verification before completion: run the real command, capture the real exit code, never claim green without evidence. (No `src/` changes in this increment → no new unit tests; CI + image smokes are the test surface.)
- Commit format `type(component): message`. No `cd` when already in the repo. No git pager flags.
- The `rtk` proxy may summarize command output — verify gates with direct commands and real exit codes.

---

## File structure

```
package.json          modify: packageManager field (exact pnpm version)
pnpm-lock.yaml        create (generated); package-lock.json deleted
.github/workflows/ci.yml  modify: test job → pnpm; new docker job
Dockerfile            create
.dockerignore         create
docker-compose.yml    create
README.md             modify: Docker-first server section; pnpm paths
docs/increment-2-docker/impl.md  create (running notes + verification evidence)
```

---

### Task 1: Branch + pnpm switch

**Files:**
- Modify: `package.json`
- Create: `pnpm-lock.yaml` (generated)
- Delete: `package-lock.json`

- [ ] **Step 1: Create feature branch**

```powershell
git checkout -b feat/ffl-2-docker
```

- [ ] **Step 2: Resolve the exact current pnpm 10 version**

```powershell
npm view pnpm@10 version --json | Select-Object -Last 2
```

Take the highest listed version (call it `10.X.Y` below — substitute the real value everywhere).

- [ ] **Step 3: Pin it in `package.json`**

Add to the top-level object (after `"type": "module",`):

```json
  "packageManager": "pnpm@10.X.Y",
```

- [ ] **Step 4: Enable corepack and install**

```powershell
corepack enable
Remove-Item package-lock.json
pnpm install
```

Expected: `pnpm-lock.yaml` created; `node_modules` rebuilt in pnpm layout (a `node_modules/.pnpm` virtual store appears). If `corepack enable` fails with a permissions error on Windows, run `corepack enable --install-directory "$env:USERPROFILE\.corepack-bin"` and add that directory to PATH for the session, or fall back to invoking `corepack pnpm <cmd>` everywhere `pnpm <cmd>` appears.

- [ ] **Step 5: Run ALL gates under pnpm (real exit codes)**

```powershell
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
```

Expected: identical results to npm — typecheck/lint clean, **70 tests pass**, build emits `dist/agentphone.js`. pnpm's stricter `node_modules` can surface phantom-dependency imports; if any module fails to resolve, add it as an explicit dependency (report it — do not work around with hoisting config).

- [ ] **Step 6: Commit**

```powershell
git add package.json pnpm-lock.yaml
git rm --cached package-lock.json 2>$null; git add -A
git commit -m "chore: switch to pnpm with exact-pinned packageManager"
```

### Task 2: CI test job → pnpm

**Files:**
- Modify: `.github/workflows/ci.yml` (test job steps only)

- [ ] **Step 1: Replace the test job's steps**

```yaml
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm run typecheck
      - run: pnpm run lint
      - run: pnpm test
```

(`corepack enable` must run BEFORE `actions/setup-node` — the `cache: pnpm` option invokes `pnpm store path` during setup.)

- [ ] **Step 2: Commit and push; verify the matrix live**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: run the gate matrix under pnpm"
git push -u origin feat/ffl-2-docker
gh run watch --exit-status (gh run list --branch feat/ffl-2-docker --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: all four legs (windows/macos × node 22/24) green under pnpm. Do not proceed until green.

### Task 3: Dockerfile, .dockerignore, compose

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
# builder
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm run build \
 && pnpm prune --prod

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
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4747/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/agentphone.js"]
CMD ["serve"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
dist
.git
.github
docs
assets
coverage
*.db
*.db-journal
*.db-wal
*.db-shm
*.jsonl
README.md
CLAUDE.md
LICENSE
docker-compose.yml
Dockerfile
.dockerignore
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  agentphone:
    image: ghcr.io/omnith/agentphone:latest
    container_name: agentphone
    ports:
      - "4747:4747"
    volumes:
      - agentphone-data:/data
    restart: unless-stopped

volumes:
  agentphone-data:
```

- [ ] **Step 4: Local build + smoke IF Docker is available on this machine**

```powershell
docker version
```

If that fails (no local Docker), skip to Step 5 — the CI docker job (Task 4) is the authoritative smoke. Otherwise:

```powershell
docker build -t agentphone:dev .
docker volume create ap-dev
docker run -d --name ap-dev -p 47473:4747 -v ap-dev:/data agentphone:dev
Start-Sleep -Seconds 5
Invoke-WebRequest http://127.0.0.1:47473/api/health -UseBasicParsing | Select-Object -ExpandProperty StatusCode   # expect 200
docker run --rm -v ap-dev:/data agentphone:dev admin invite --name local-smoke                                     # expect ap-invite-...
docker rm -f ap-dev; docker volume rm ap-dev
```

- [ ] **Step 5: Commit**

```powershell
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "feat(docker): add slim multi-stage image with container-first defaults"
```

### Task 4: CI docker job (smoke-gated GHCR publish)

**Files:**
- Modify: `.github/workflows/ci.yml` (append job)

- [ ] **Step 1: Append the `docker` job**

```yaml
  docker:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - name: Build amd64 image for smoke
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          load: true
          tags: agentphone:smoke
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Smoke test image (health + admin invite)
        run: |
          docker volume create ap-smoke
          docker run -d --name ap -p 47472:4747 -v ap-smoke:/data agentphone:smoke
          ok=""
          for i in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:47472/api/health >/dev/null 2>&1; then ok=1; break; fi
            sleep 2
          done
          if [ -z "$ok" ]; then docker logs ap; exit 1; fi
          out=$(docker run --rm -v ap-smoke:/data agentphone:smoke admin invite --name ci-smoke)
          echo "$out"
          echo "$out" | grep -q "ap-invite-" || exit 1
          docker rm -f ap
      - name: Log in to GHCR
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/omnith/agentphone
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,prefix=sha-
      - name: Build and push multiarch
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

(Image name must be lowercase `ghcr.io/omnith/agentphone` even though the org is `Omnith`.)

- [ ] **Step 2: Commit, push, verify the branch run**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: add smoke-gated multiarch ghcr publish job"
git push origin feat/ffl-2-docker
gh run watch --exit-status (gh run list --branch feat/ffl-2-docker --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: test matrix green AND the docker job green — amd64 build + smoke pass; the login/push steps are SKIPPED (not main). Do not proceed until green.

### Task 5: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "Server — once, on one machine" section with a Docker-first version**

````markdown
## Server — once, on one machine

**Docker (recommended):**

```bash
docker run -d --name agentphone -p 4747:4747 -v agentphone:/data \
  ghcr.io/omnith/agentphone:latest
docker exec agentphone node dist/agentphone.js admin invite --name volumi
```

or with compose: `docker compose up -d` (see `docker-compose.yml`). State (SQLite + event log)
lives in the `agentphone` volume; the `-p` mapping is the only network exposure to configure —
no per-executable Windows firewall rules.

**From source (PowerShell shown):**

```powershell
corepack enable
pnpm install; pnpm run build
$env:AGENTPHONE_BIND = "0.0.0.0"        # expose beyond localhost (e.g. on your mesh/VPN)
node dist/agentphone.js serve            # listens on :4747
```
````

- [ ] **Step 2: Update the Provisioning section's command context**

Keep the existing invite/list/revoke lines but present both forms:

````markdown
Mint a single-use invite for each agent that should be allowed in:

```bash
# docker:       docker exec agentphone node dist/agentphone.js admin invite --name volumi
# from source:  node dist/agentphone.js admin invite --name volumi
```
````

(Keep the existing `admin list` / `admin revoke` / same-`AGENTPHONE_DB` paragraph as is — for
docker, the shared volume satisfies the same-DB requirement automatically.)

- [ ] **Step 3: Switch the agent install block to pnpm**

Replace `npm install && npm run build && npm link` with:

```bash
corepack enable                              # ships with Node 22 - makes pnpm available
pnpm install && pnpm run build && pnpm link --global   # puts `agentphone` on your PATH
# (if pnpm complains about a global bin dir, run `pnpm setup` once and re-open the shell)
```

- [ ] **Step 4: Switch the Development section to pnpm**

```bash
pnpm test          # vitest, in-memory SQLite
pnpm run typecheck && pnpm run lint
pnpm run build     # tsup -> dist/agentphone.js
```

- [ ] **Step 5: Commit**

```powershell
git add README.md
git commit -m "docs: docker-first server quickstart and pnpm paths"
```

### Task 6: impl notes, PR, merge, publish verification

**Files:**
- Create: `docs/increment-2-docker/impl.md`

- [ ] **Step 1: Write `docs/increment-2-docker/impl.md`** with sections `Decisions & deviations`, `Review findings & resolutions`, `Deferred debt`, `Verification evidence` — record the actual pnpm version pinned, gate outputs, CI run links/results, and any deviations encountered so far.

- [ ] **Step 2: Final local verification (real exit codes)**

```powershell
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
```

- [ ] **Step 3: Commit, push, PR**

```powershell
git add docs/increment-2-docker/impl.md
git commit -m "docs: record increment-2 verification evidence"
git push origin feat/ffl-2-docker
gh pr create --base main --title "feat: multiarch docker image + pnpm (increment 2)" --body "..."
```

(PR body: summary of the two deliverables + evidence; end with the Claude Code footer per harness convention.)

- [ ] **Step 4: Wait for PR CI (matrix + docker smoke) green, then merge**

```powershell
gh pr checks <n> --watch --interval 30
gh pr merge <n> --merge --delete-branch
git checkout main; git pull
```

- [ ] **Step 5: Verify the publish on main**

The merge push to main triggers the docker job WITH push. Watch it, then confirm the package:

```powershell
gh run watch --exit-status (gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
gh api "orgs/Omnith/packages/container/agentphone/versions" --jq '.[0].metadata.container.tags'
```

Expected: run green including the multiarch push; package versions show `latest` and `sha-*` tags. Record in impl.md (small docs commit to main). Manual acceptance (user-side, not in this plan): `docker compose up -d` on the Windows box + register from the MacBook.

---

## Plan self-review (completed by plan author)

1. **Spec coverage:** pnpm switch → T1/T2/T5; Dockerfile+ignore+compose → T3; smoke-gated GHCR publish → T4; README → T5; acceptance criteria 1-5 map to T1-T2 (gates under pnpm), T4/T6 (publish + gating), T3/T4 (healthy container + invite via exec/one-shot), T5 (docs). Design's error-handling notes need no tasks (increment-1 behavior).
2. **Placeholder scan:** the PR body "..." in T6 is intentionally summarized (content specified in prose beside it); all file contents are complete.
3. **Consistency:** image name lowercase everywhere; smoke port 47472 (CI) vs 47473 (local) don't collide with 4747; `pnpm@10.X.Y` placeholder is explicitly resolved in T1 Step 2 and must be substituted everywhere it appears (T1 Step 3 only).
