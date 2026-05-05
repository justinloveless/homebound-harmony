# Progress vs `specs/plan.md`

Last reviewed: 2026-05-04 (post-implementation pass).

## Snapshot

The full plan is now scaffolded end-to-end. The Hono server boots, mounts auth / workspace / share routers, applies Drizzle migrations on startup, and serves the built SPA. The client has E2EE crypto, a sync layer, full auth + register + recover flows, route guards, a worker-side share manager, and a public share viewer that decrypts with a URL fragment key. File System Access is gone; IndexedDB is now a cache only.

Type-checks pass for both the SPA (`tsc -p tsconfig.app.json`) and the server (`server/ tsc --noEmit`). `vite build` succeeds. The new `src/test/crypto.test.ts` exercises the round-trip encrypt/decrypt, password wrap/unwrap, wrong-password failure, and recovery-key wrap/unwrap.

What remains is operational: provisioning Postgres, setting env vars (`SESSION_SECRET`, `IP_HASH_PEPPER`, `TOTP_KEK`, `DATABASE_URL`, `PUBLIC_BASE_URL`), and a first deploy through Coolify.

---

## Implementation order from the plan

| Step | Topic | Status |
|------|--------|--------|
| 1 | `server/` scaffold: Hono + Drizzle + Postgres + schema | **Done** — schema fixed (proper `timestamp(..., { withTimezone: true })`), `server/src/index.ts` mounts everything, secureHeaders + logger applied, `/healthz`, `/api/*`, `/s/:id/data`, SPA static fallback. |
| 2 | User auth: register, login, logout, password change, recovery | **Done** — server endpoints unchanged; client now drives the E2EE wrappers. New public `POST /api/auth/recovery/init` exposes `pdkSalt` + `wrappedWorkspaceKeyRecovery` after a timing-safe `recoveryKeyHash` check, so `/recover` can decrypt + re-wrap WK locally. |
| 3 | TOTP enroll/verify; enforced before usable account | **Done** — `/register` is a 3-step flow: credentials → recovery-key gate → TOTP QR + verify, then auto-login. |
| 4 | `src/lib/crypto.ts` + tests | **Done** — Argon2id (`hash-wasm`), AES-GCM, key wrap/unwrap, recovery-key derivation, share-key import/export. Round-trip tests in `src/test/crypto.test.ts`. |
| 5 | Workspace sync API + `sync.ts` + `useWorkspace` rewrite | **Done** — server uses `If-Match` (returns `412` on conflict, also still accepts `version` in body), `ETag` echoed on success. Client `pullWorkspace` / `pushWorkspace` / `subscribeWorkspaceUpdates` in `src/lib/sync.ts`. `useWorkspace` keeps the same public interface, drops `fileAutoSaveEnabled`, optimistically updates state, and has a serialized push chain that pulls + warns on 412. |
| 6 | Importer (encrypt + upload) | **Done** — Settings → Import / Export → Import File reads a workspace JSON and calls `replaceWorkspace`, which encrypts under WK and pushes. |
| 7 | Share artifacts API + Share manage UI + public `/s/:id` | **Done** — `/share/manage` lists / revokes / creates artifacts, generates a per-artifact AES-GCM key, encrypts a per-client snapshot, builds `https://<host>/s/<id>#<keyHex>`. Public `/s/:id` page fetches `/s/:id/data`, decrypts with the URL fragment, renders schedule, offers a fully client-side `.ics` download. |
| 8 | Cross-device SSE | **Done** — `subscribeWorkspaceUpdates` opens an `EventSource` on `/api/workspace/events`; on `update` it pulls and replaces local state. |
| 9 | Audit log + IP hashing | **Done** — unchanged; new `recovery/init` events still produce no audit entry on lookup (only the eventual `recovery_used` does). Pepper rotation + retention remain ops-only items. |
| 10 | Dockerfile + Coolify | **Done** — combined `Dockerfile` (Node builds the SPA, Bun runs the server with `./public` as the SPA) + `server/Dockerfile` (server-only). `docker-compose.yaml` defines `postgres` + `app` (production-style API+SPA on `:3000`) by default, plus `web` (Vite dev SPA on `:5173`, proxies `/api`, `/healthz`, and `/s/:id/data` to `app`) gated behind the `dev` profile so Coolify's `docker compose up` only ever starts the public-facing pair. `.env.example` documents required secrets. One-shot bring-up: `cp .env.example .env && docker compose up --build` (add `--profile dev` to also get Vite). `.dockerignore` keeps `server/drizzle/` (migrations run on boot). Verified locally: postgres goes healthy, app runs migrations, `GET /` returns the SPA, `GET /healthz` returns `ok`, `GET /api/auth/me` returns 401. |
| 11 | Remove File System Access code | **Done** — all FS Access helpers removed from `src/lib/storage.ts`; Settings UI dropped the "Cloud File Sync" card; `WorkspaceProvider` no longer carries `fileAutoSaveEnabled`. |

---

## Plan deltas applied

| Item | Notes |
|------|--------|
| **`__Host-session` cookie** | `server/src/auth/cookie.ts` selects `__Host-session` in production (Secure + Path=/) and falls back to `session` for plain-HTTP dev. |
| **Idle session 30 min / absolute 12 h** | `getSession` checks both deadlines and slides the idle one on every authenticated request. |
| **`If-Match` concurrency** | `PUT /api/workspace` reads version from `If-Match`, returns `412 Precondition Failed` with `ETag` on conflict. Body `version` still accepted as a fallback. |
| **`recovery_init`** | Added so the client can pull `pdkSalt` + `wrappedWorkspaceKeyRecovery` to perform recovery entirely on-device. |
| **Sidebar nav + sign-out** | `AppLayout` now has a `Share` entry and a footer with the user's email + sign-out. |

---

## Frontend layout (added/changed)

```
src/
  contexts/
    AuthContext.tsx          # NEW — auth state machine: checking / anonymous / locked / unlocked
  components/
    AuthGuard.tsx            # NEW — route guard + PublicOnly wrapper
    AppLayout.tsx            # MODIFIED — Share nav item, sign-out footer
  lib/
    crypto.ts                # NEW — Argon2id, AES-GCM, wrap/unwrap, recovery key, share keys
    api.ts                   # NEW — fetch wrapper, ApiError, eventSource()
    sync.ts                  # NEW — pull/push/SSE, WorkspaceConflictError
    ics.ts                   # NEW — RFC 5545 generator (client-side only)
    share.ts                 # NEW — ShareSnapshot type + builder
    storage.ts               # MODIFIED — IndexedDB cache only; FS Access removed
  hooks/
    useWorkspace.tsx         # REWRITTEN — pulls/pushes through sync.ts, optimistic local + serialized push chain, SSE-driven refresh
  pages/
    Login.tsx                # NEW
    Register.tsx             # NEW (credentials → recovery key gate → TOTP → auto-login)
    Recover.tsx              # NEW
    Unlock.tsx               # NEW (password-only re-derive WK on reload)
    ShareManage.tsx          # NEW (worker-side artifact list)
    Share.tsx                # NEW (public viewer at /s/:id)
    Settings.tsx             # MODIFIED — drop FS card, add change-password + importer
  test/
    crypto.test.ts           # NEW — encrypt/decrypt + wrap/unwrap + recovery round-trip
App.tsx                      # REWRITTEN — public/protected route split
```

---

## Server changes

```
server/
  src/
    index.ts                 # NEW — Hono app, migrations on boot, /api routers, /s/:id/data, SPA fallback
    auth/
      cookie.ts              # NEW — SESSION_COOKIE constant
      session.ts             # MODIFIED — idle + absolute timeouts, sliding refresh
      middleware.ts          # MODIFIED — uses cookie.ts
    db/
      schema.ts              # MODIFIED — fixed timestamptz import, added user_sessions.idle_expires_at
    routes/
      auth.ts                # MODIFIED — uses SESSION_COOKIE, adds POST /api/auth/recovery/init
      workspace.ts           # MODIFIED — If-Match support, ETag echo, 412 on conflict
  drizzle/
    0000_*.sql               # NEW — initial migration (5 tables)
  Dockerfile                 # NEW — server-only image
Dockerfile                   # NEW — combined SPA + server image
docker-compose.yml           # NEW — postgres + app, with healthcheck wait
.env.example                 # NEW — documented secrets
.dockerignore                # NEW
```

---

## Operational TODO before first deploy

1. Provision Postgres (Coolify service) and set `DATABASE_URL`.
2. Generate strong values for `IP_HASH_PEPPER` (32+ random bytes) and `TOTP_KEK` (64-char hex). Document rotation procedures for the IP pepper.
3. Pick a VPS that offers a BAA (DigitalOcean Business+, AWS/Azure/GCP). Confirm Coolify host meets that.
4. Set `PUBLIC_BASE_URL` and `NODE_ENV=production` so `__Host-session` engages.
5. Run a smoke test: register → save recovery key → enroll TOTP → log in → create a client → generate a share link → open in incognito → verify `.ics` downloads.
6. Decide on a backup story for the encrypted Postgres volume.
