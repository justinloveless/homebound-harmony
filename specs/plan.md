# Backend + E2EE Sync + Share Artifacts — Plan

## Product framing

This app is a **general-purpose appointment scheduling tool**. The first customer is a home health worker, but the architecture is not healthcare-specific. The server is an **end-to-end encrypted storage and auth backend**: it holds ciphertext only, and never sees plaintext appointment data, contact details, addresses, or notes.

This makes the product HIPAA-compatible without being a healthcare app, and gives every user — healthcare or not — the same privacy posture: "your data is yours; even we can't read it."

## Tradeoffs accepted up front

- **No live `.ics` calendar subscription.** Schedules are shared as one-shot encrypted artifacts; updates require the worker to regenerate and resend the link.
- **No in-app reschedule flow.** Clients communicate scheduling changes out of band (text, phone, email).
- **Lost password + lost recovery key = lost data.** Standard E2EE tradeoff. Mitigated by forced recovery-key display at signup with "I've saved this" gate and periodic reminders.
- **MFA is enforced.** TOTP required for every user.

## Repo layout

```
server/
  src/
    index.ts          # Hono app
    db/
      schema.ts       # Drizzle schema (5 tables)
      client.ts
      migrate.ts
    auth/
      session.ts
      middleware.ts
      argon.ts
      totp.ts
    routes/
      auth.ts
      workspace.ts    # encrypted blob sync
      share.ts        # share artifacts
    services/
      audit.ts
      ipHash.ts
  drizzle/            # generated migrations
  package.json
  tsconfig.json
  Dockerfile
src/                  # existing web app
  lib/
    crypto.ts         # NEW: argon2id, AES-GCM, wrap/unwrap, recovery key
    sync.ts           # NEW: pull/push workspace blob, conflict handling, SSE
    api.ts            # NEW: fetch wrapper
  pages/
    Login.tsx         # NEW
    Register.tsx      # NEW (shows recovery key once)
    ShareManage.tsx   # NEW (worker-side share artifact list)
    Share.tsx         # NEW (public /s/:id viewer)
Dockerfile            # combined image: server serves API + SPA fallback
```

Combined deploy: one Bun process serves `/api/*`, `/s/*`, and the built SPA fallback. One Coolify service, one domain, no CORS.

## Server schema (Drizzle, entire schema)

```
users (
  id uuid pk,
  email text unique,
  password_hash text,             -- argon2id, used for login auth ONLY (not key derivation)
  totp_secret_encrypted bytea,    -- encrypted with server-side KEK; required, no opt-out
  recovery_key_hash text,         -- argon2id hash of the recovery key (server validates without learning it)
  master_public_key bytea,        -- X25519, reserved for future multi-user sharing
  created_at, updated_at
)

user_sessions (
  id text pk,                     -- random session id stored in cookie
  user_id uuid fk,
  expires_at timestamptz,
  created_at
)

workspace_blobs (
  user_id uuid pk fk,
  ciphertext bytea,               -- AES-256-GCM
  iv bytea,
  wrapped_workspace_key bytea,    -- WK wrapped under password-derived key (envelope)
  wrapped_workspace_key_recovery bytea,  -- WK also wrapped under recovery key for password recovery
  version bigint,                 -- optimistic concurrency
  updated_at timestamptz
)

share_artifacts (
  id text pk,                     -- random 32-byte hex
  user_id uuid fk,
  ciphertext bytea,               -- AES-256-GCM, key lives ONLY in URL fragment
  iv bytea,
  expires_at timestamptz,         -- default 30 days, max 1 year
  revoked_at timestamptz,
  fetch_count int,
  last_fetched_at timestamptz,
  created_at
)

audit_events (
  id uuid pk,
  user_id uuid fk nullable,
  artifact_id text nullable,
  action text,                    -- 'login' | 'logout' | 'password_change' | 'recovery_used' | 'share_create' | 'share_revoke' | 'share_fetch' | 'totp_enroll'
  ip_hash text,                   -- HMAC-SHA256(ip, server_pepper); never raw IP
  user_agent text,
  occurred_at timestamptz
)
```

No `clients`, no `visits`, no `travel_times`, no `client_change_requests`, no `client_time_windows`. Those structures live inside the encrypted workspace blob and are only ever decrypted on the worker's device.

## Encryption design

- **Password-derived key (PDK):** Argon2id over the user's password with high parameters and a server-published per-user salt. Computed in the browser (`argon2-browser` or libsodium-js).
- **Workspace key (WK):** random 256-bit, generated once at signup. Encrypts the workspace blob with AES-256-GCM. Stored on the server as ciphertext **wrapped under PDK** (envelope encryption). Password change re-wraps WK; it does not require re-encrypting the workspace.
- **Recovery key:** random 256-bit, displayed once at signup as a human-friendly string (24-word phrase or hex). The user prints/saves it offline. WK is *also* wrapped under the recovery key (`wrapped_workspace_key_recovery`) so a forgotten password is recoverable. The server stores only `recovery_key_hash` for validation, never the key itself.
- **Share-artifact keys:** per-artifact random 256-bit, never sent to the server. Embedded in the URL fragment (`/s/<id>#<key>`); browsers do not transmit fragments to servers.
- **Algorithms:** AES-256-GCM via Web Crypto API for symmetric encryption; Argon2id for KDF; HKDF for any subkey derivation; X25519 reserved for future shared-vault flow.

## API surface

```
# Auth
POST /api/auth/register             # creates user, returns recovery key once (shown then discarded server-side)
POST /api/auth/login                # password + TOTP -> session cookie
POST /api/auth/logout
GET  /api/auth/me
POST /api/auth/totp/enroll          # required as part of registration completion
POST /api/auth/totp/verify
POST /api/auth/password/change      # client re-wraps WK, uploads new wrapped_workspace_key
POST /api/auth/recovery             # uses recovery key to re-wrap WK and reset password

# Workspace blob sync
GET  /api/workspace                 # returns ciphertext + iv + wrapped_workspace_key + version
PUT  /api/workspace                 # If-Match: <version>; rejects on conflict
GET  /api/workspace/events          # SSE for cross-device updates

# Share artifacts
POST   /api/share                   # body: ciphertext, iv, expires_at; returns id
GET    /s/:id/data                  # public; returns ciphertext + iv only (no IP logging beyond hash)
DELETE /api/share/:id                # revoke

# Static
GET /s/:id                          # SPA shell — fetches /s/:id/data, decrypts using URL fragment
```

`requireUser` middleware on every `/api/*` except `/api/auth/login`, `/api/auth/register`, `/api/auth/recovery`, and `/s/:id/data`.

## Auth

- Session-cookie auth, sessions stored in `user_sessions`. Cookie: `__Host-session`, `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Argon2id for the **login password hash** (separate from the client-side Argon2id used for key derivation — same algo, different role).
- **TOTP enforced.** Registration is incomplete until TOTP is enrolled. No password-only login.
- Idle session timeout 30 min; absolute timeout 12h.
- Account lockout after 10 failed attempts within 15 min.

## Travel times and mapping

- Server is never involved.
- Default: `estimateTravelMinutes` (haversine) on the worker's device, already implemented in `src/types/models.ts`.
- Optional: worker provides their own Google Maps API key in settings; calls go directly from the browser. The user's data and their API choice; the server never sees addresses.

## Sharing flow with the worker's clients

1. Worker selects a client → "Generate share link."
2. Device generates a random per-artifact 256-bit key, builds the client's schedule snapshot in memory, encrypts it with AES-256-GCM, and uploads the ciphertext to `POST /api/share` with an `expires_at` (default 30 days).
3. Server returns `{ id }`. Device builds URL: `https://yourapp.com/s/<id>#<key>` and shows it to the worker (copy button + per-channel share helpers).
4. Worker sends the URL to the client (text, email, paper).
5. Client opens it → static SPA shell at `/s/<id>` loads → fetches ciphertext from `/s/<id>/data` → reads key from `window.location.hash` → decrypts client-side → renders read-only schedule.
6. Page offers "Download `.ics`" — file generated client-side from decrypted data, never touches the server.
7. When the schedule changes, the worker re-publishes (new artifact or replaces). Old artifacts can be revoked from the worker's `Share manage` page.

No subscription, no in-app reschedule. The share page includes "If you need to change a visit, contact [worker]" with a `mailto:` / `tel:` link the worker pre-configures in their workspace.

## Audit log scope

Recorded:
- `login`, `logout`, `password_change`, `recovery_used`
- `totp_enroll`
- `share_create`, `share_revoke`, `share_fetch`

Not recorded:
- Workspace-blob fetches (happen constantly, add no value)

Every event captures `ip_hash` (HMAC-SHA256(ip, server-side pepper) — pepper never leaves the server, raw IP never written to disk) and `user_agent`. Retain ≥6 years for HIPAA-compatible operation. The pepper rotates on a schedule that's documented in ops; rotation makes prior IPs uncorrelatable.

## Vendor / BAA posture

Even though the server only holds ciphertext, the home health customer will likely require a BAA from us. Posture:

- Be prepared to sign a BAA with healthcare customers.
- E2EE design is documented as the primary security control.
- VPS provider (whoever Coolify runs on) must offer a BAA — confirm before launch. Hetzner does **not**; DigitalOcean does on Business+; AWS/Azure/GCP/Vultr/Linode do on specific tiers.
- No SMTP provider in the design (no transactional email).
- No mapping API on the server (worker uses their own key from their browser).
- Backups: encrypted Postgres backups land on storage with a BAA in place (or on the same VPS volume the BAA already covers).

## Frontend changes

- New `src/lib/crypto.ts` — Argon2id KDF, AES-GCM encrypt/decrypt, key wrap/unwrap, recovery-key generation + validation.
- New `src/lib/sync.ts` — pull workspace on login, push on local changes, version-based optimistic concurrency, SSE listener for cross-device updates, conflict surface (last-writer-wins for v1; simple "your other device made changes — reload?" prompt).
- New `src/lib/api.ts` — `fetch` wrapper, always `credentials: 'include'`, throws on non-2xx.
- **Delete from `src/lib/storage.ts`:** File System Access code (`saveWorkspaceToFile`, `openWorkspaceFromFile`, `autoSaveToFile`, `_currentFileHandle`, `clearFileHandle`, `isFileSystemAccessSupported`, `getCurrentFileHandle`). Keep `exportWorkspace` / `importWorkspace` JSON helpers for the importer. Keep IndexedDB as a local cache for offline use; sync layer is source of truth.
- **Rewrite `src/hooks/useWorkspace.tsx`** internally to read/write through `sync.ts`. Public interface stays the same so `Clients.tsx`, `Schedule.tsx`, `Settings.tsx`, `TravelTimes.tsx`, `Workspace.tsx` are unaffected. Drop `fileAutoSaveEnabled` / `setFileAutoSaveEnabled` from the interface.
- New routes:
  - `/login` — email + password + TOTP code
  - `/register` — creates account, displays recovery key once with a "I've saved it" gate, enforces TOTP enrollment before completion
  - `/recover` — recovery-key-driven password reset
  - `/share/manage` — worker-side list of active artifacts with revoke + copy
  - `/s/:id` — public viewer (no auth, no app context, just decrypts and renders)
- Route guard wrapping authenticated routes; redirects to `/login`.

## Importer

- One-time UI under Settings → "Import legacy data."
- Reads from `loadWorkspace()` (one final call before retiring it as primary) **or** from an uploaded exported JSON file.
- Encrypts the workspace client-side under the user's WK and uploads as the first `workspace_blobs` row.
- Idempotent: importing again replaces the current blob (with a confirmation step).

## Coolify deploy

- `server/Dockerfile`: `oven/bun:1` base, build, run migrations on boot, then start.
- Root `Dockerfile`: combined — builds web app, copies `dist/` into the server image, server serves SPA fallback.
- Coolify: create Postgres service → app service consumes `DATABASE_URL`. App env: `SESSION_SECRET`, `IP_HASH_PEPPER`, `TOTP_KEK`, `PUBLIC_BASE_URL`.
- VPS provider must offer a BAA (see Vendor section).

## Implementation order

1. `server/` scaffold: Hono + Drizzle + Postgres, simplified schema (`users`, `user_sessions`, `workspace_blobs`, `share_artifacts`, `audit_events`).
2. User auth: register (with recovery-key display + "I've saved it" gate), login, logout, password change, recovery.
3. TOTP enroll/verify; enforce TOTP completion as part of registration.
4. Client-side crypto module (`src/lib/crypto.ts`): Argon2id, AES-GCM, wrap/unwrap, recovery key generation + validation. Unit tests for round-trip, password change, recovery.
5. Workspace sync API + `src/lib/sync.ts`. Rewrite `useWorkspace` to read/write through it. IndexedDB becomes a local cache.
6. Importer: encrypt + upload current IndexedDB workspace.
7. Share artifacts: API (`POST /api/share`, `DELETE /api/share/:id`, `GET /s/:id/data`), worker-side `Share manage` UI, public `/s/:id` SPA, client-side `.ics` generation.
8. Cross-device sync via SSE.
9. Audit log with IP hashing; pepper rotation procedure documented.
10. Dockerfile + Coolify wiring + first deploy.
11. Remove File System Access code. Keep IndexedDB only as offline cache.
