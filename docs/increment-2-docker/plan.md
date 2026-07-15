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

- [ ] **Step 3: Pin it in `package.json` AND allowlist native build scripts**

Add to the top-level object (after `"type": "module",`):

```json
  "packageManager": "pnpm@10.X.Y",
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3", "esbuild"]
  },
```

CRITICAL: pnpm 10 blocks dependency lifecycle scripts by default. Without `onlyBuiltDependencies`,
better-sqlite3's install script (which fetches its native `.node` binding) is silently skipped —
`pnpm install` exits 0 with an "Ignored build scripts" warning and every test then fails with
"Could not locate the bindings file". esbuild (tsup's engine) is allowlisted for the same reason.

- [ ] **Step 4: Update `.prettierignore` for the new lockfile**

Replace the `package-lock.json` line with `pnpm-lock.yaml` (the generated lockfile is not
prettier-formatted; without this, `pnpm run lint` fails at `prettier --check .`).

- [ ] **Step 5: Enable corepack and install**

```powershell
corepack enable
Remove-Item package-lock.json
pnpm install
```

Expected: `pnpm-lock.yaml` created; `node_modules` rebuilt in pnpm layout (a `node_modules/.pnpm` virtual store appears); NO "Ignored build scripts" warning for better-sqlite3. If `corepack enable` fails with a permissions error on Windows, run `corepack enable --install-directory "$env:USERPROFILE\.corepack-bin"` and add that directory to PATH for the session, or fall back to invoking `corepack pnpm <cmd>` everywhere `pnpm <cmd>` appears.

- [ ] **Step 6: Run ALL gates under pnpm (real exit codes)**

```powershell
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
```

Expected: identical results to npm — typecheck/lint clean, **70 tests pass**, build emits `dist/agentphone.js`.
Troubleshooting: (a) "Could not locate the bindings file" for better-sqlite3 = its build script
was blocked — confirm it's listed in `pnpm.onlyBuiltDependencies` (NOT a phantom-dep problem);
(b) a module genuinely failing to RESOLVE = pnpm's stricter node_modules surfaced a phantom
dependency — add it as an explicit dependency and report it.

- [ ] **Step 7: Commit**

```powershell
git add -A
git commit -m "chore: switch to pnpm with exact-pinned packageManager"
```

### Task 2: CI test job → pnpm

**Files:**
- Modify: `.github/workflows/ci.yml` (test job steps only)

- [ ] **Step 1: Replace the test job's steps**

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
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

(The double `setup-node` is deliberate and is the robust documented pattern: the first pins the
Node version, `corepack enable` shims pnpm into THAT Node's bin dir, and the second run's
`cache: pnpm` probe (`pnpm store path`) then finds pnpm reliably on all OSes. A single
setup-node with corepack before it is known-flaky on Windows runners.)

- [ ] **Step 2: Commit and push; verify the matrix live**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: run the gate matrix under pnpm"
git push -u origin feat/ffl-2-docker
$sha = git rev-parse HEAD
$rid = $null
for ($i = 0; $i -lt 10 -and -not $rid; $i++) {
  Start-Sleep -Seconds 5
  $rid = gh run list --branch feat/ffl-2-docker --json databaseId,headSha --jq "map(select(.headSha==`"$sha`"))[0].databaseId"
}
gh run watch $rid --exit-status
```

(Resolve the run by the pushed commit's SHA — `--limit 1` right after a push races the run
registration and can watch a stale run or error on an empty id.)

Expected: all four legs (windows/macos × node 22/24) green under pnpm. Do not proceed until
green. On a red leg: `gh run view $rid --log-failed`; the two likeliest causes are a blocked
better-sqlite3 build script (see Task 1 Step 3) or an OS-specific phantom-dependency resolution.

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
# note: not hermetic - better-sqlite3's install script downloads its linux prebuilt
# from GitHub Releases at install time (slim has no compiler fallback by design)
RUN pnpm install --frozen-lockfile \
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
docker compose config -q      # validate compose syntax while we're here
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
          out2=$(docker exec ap node dist/agentphone.js admin invite --name ci-smoke-exec)
          echo "$out2"
          echo "$out2" | grep -q "ap-invite-" || exit 1
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

- [ ] **Step 2: Restate the invite/list/revoke block inside the new section**

NOTE ON BOUNDARIES: there is no section literally named "Provisioning" — the invite/list/revoke
lines live inside "Server — once, on one machine" today, so Step 1's replacement REMOVES them.
This step adds them back, both forms, at the END of the new Docker-first section (after the
from-source block):

````markdown
Mint a single-use invite for each agent that should be allowed in:

```bash
# docker:       docker exec agentphone node dist/agentphone.js admin invite --name volumi
# from source:  node dist/agentphone.js admin invite --name volumi
```

`admin list` / `admin revoke <name>` manage the phonebook. Provisioning is deliberately
local-only — there is no remote admin surface. From source, run `admin` with the same
`AGENTPHONE_DB` as the server (it edits the database directly); in docker, the shared
volume satisfies that automatically. Prefer the named volume shown above — a host
bind-mount to `/data` must be pre-owned by uid 1000 or the non-root server can't write it.
````

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

- [ ] **Step 3: Final holistic review (scaled for a zero-src increment)**

Per CLAUDE.md increment workflow step 6 / implementation process step 4: dispatch one review
subagent over the whole increment diff (base = main) checking: Dockerfile correctness vs the
design (incl. the reviewed pnpm 10 script-allowlist and non-hermetic-install notes), CI job
conditional logic (push gating, smoke coverage incl. the exec path), README accuracy against
the implemented commands, and docs coherence (design/plan/impl consistency, deviations
recorded). Fix HIGH/MEDIUM findings before the PR.

- [ ] **Step 4: Commit, push, PR**

```powershell
git add docs/increment-2-docker/impl.md
git commit -m "docs: record increment-2 verification evidence"
git push origin feat/ffl-2-docker
```

Then create the PR with a real body (PowerShell here-string; closing `'@` at column 0):

```powershell
gh pr create --base main --title "feat: multiarch docker image + pnpm (increment 2)" --body @'
## What

Repo-wide pnpm (exact-pinned, corepack) and a lightweight multiarch (amd64+arm64) Docker
image of the server, published to ghcr.io/omnith/agentphone on main pushes, smoke-gated
(health + admin invite via one-shot AND exec) before any push.

## Evidence

- All gates green under pnpm locally and on the windows/macos x node 22/24 matrix.
- CI docker job: amd64 build + smoke green on this branch (push steps skipped off-main).
- Review trail in docs/increment-2-docker/impl.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
'@
```

- [ ] **Step 5: Wait for PR CI (matrix + docker smoke) green, then merge**

```powershell
gh pr checks <n> --watch --interval 30
gh pr merge <n> --merge --delete-branch
git checkout main; git pull
```

- [ ] **Step 6: Verify the publish on main + make the package public**

The merge push to main triggers the docker job WITH push. Watch it (resolve the run id by
`headSha` as in Task 2), then confirm the package exists:

```powershell
gh api "orgs/Omnith/packages/container/agentphone/versions" --jq '.[0].metadata.container.tags'
```

Expected: `latest` and `sha-*` tags. (If the org is actually a user account, the path is
`users/Omnith/...` instead.)

**One-time visibility step (required for the README's anonymous `docker pull` to work):** a
freshly created GHCR package is PRIVATE by default. An org owner must set
GitHub → Omnith → Packages → agentphone → Package settings → Change visibility → Public
(and confirm the package is linked to the repo). This is a browser step — ask the user to
flip it, then verify anonymous access:

```powershell
docker logout ghcr.io
docker pull ghcr.io/omnith/agentphone:latest
```

- [ ] **Step 7: Pull-and-run the PUBLISHED image (closes acceptance criteria 2/3 for amd64)**

```powershell
docker volume create ap-pub
docker run -d --name ap-pub -p 47474:4747 -v ap-pub:/data ghcr.io/omnith/agentphone:latest
Start-Sleep -Seconds 8
Invoke-WebRequest http://127.0.0.1:47474/api/health -UseBasicParsing | Select-Object -ExpandProperty StatusCode  # expect 200
docker exec ap-pub node dist/agentphone.js admin invite --name pub-smoke                                          # expect ap-invite-...
docker run --rm -v ap-pub:/data ghcr.io/omnith/agentphone:latest admin invite --name pub-smoke2                   # expect ap-invite-...
docker rm -f ap-pub; docker volume rm ap-pub
```

(If Docker is unavailable on this machine, this becomes the first step of the user's manual
acceptance instead — state that explicitly in impl.md.) arm64 healthy-run is confirmed during
manual acceptance on the MacBook — record that as a pending item in impl.md. Record all
outcomes in impl.md (small docs commit to main). Manual acceptance (user-side, not in this
plan): `docker compose up -d` on the Windows box + register from the MacBook.

---

## Plan self-review (completed by plan author, rev 2)

1. **Spec coverage:** pnpm switch → T1/T2/T5; Dockerfile+ignore+compose → T3; smoke-gated GHCR publish (incl. exec-path invite) → T4; README → T5; published-image verification + GHCR visibility → T6. All five acceptance criteria now have closing verification (AC2/AC3 amd64 closed by T6 Step 7; arm64 explicitly deferred to MacBook manual acceptance and recorded).
2. **Placeholder scan:** PR body is now a complete here-string; `10.X.Y` is explicitly resolved in T1 Step 2 and substituted only in T1 Step 3.
3. **Consistency:** image name lowercase everywhere; ports 4747 / 47472 (CI) / 47473 (local dev) / 47474 (published smoke) don't collide.
4. **Review-gate traceability (rev 2):** both plan reviewers' HIGHs fixed (pnpm 10 `onlyBuiltDependencies` allowlist + corrected troubleshooting; `.prettierignore` lockfile swap); MEDIUMs fixed (robust double setup-node CI bootstrap; GHCR visibility step; bind-mount ownership note; `--offline` dropped with non-hermetic comment; headSha-based run watching with red-leg guidance; README step boundaries; real PR body + holistic review step; published-image pull/run incl. exec invite). LOWs folded (compose config validation, `git rm --cached` dropped) or noted for impl.md (chown /data-only deviation, busy_timeout, double-trigger cost, arm64 smoke tradeoff).
