# Coordinated release: event-driven audit (snapshot + events)

This runbook applies when shipping the **event log + snapshot** API together with **web** and **iOS** builds. All three must agree on encryption, event kinds, and minimum client version.

## 1. Version pins (do first)

| Surface | Location | Bump when |
|--------|----------|-----------|
| Server | `MIN_CLIENT_VERSION` env (see `.env.example`) | Breaking API or audit contract |
| Web | `VITE_APP_CLIENT_VERSION` / `APP_CLIENT_VERSION` in `src/lib/version.ts` | Same as server bump |
| iOS | `ClientVersion.current` in `ios/Sources/HomeboundHarmony/ClientVersion.swift` | Same as server bump |

**Rule:** `MIN_CLIENT_VERSION` must not advance past a shipped client until that client is in users’ hands (or you intentionally force upgrades).

## 2. Deploy order

1. **Database** — run migrations (`server/drizzle`) so `workspace_snapshots`, `data_events`, and `user_event_chain` exist before traffic hits new code.
2. **Server** — deploy API with `/api/snapshot`, `/api/events`, legacy `/api/workspace` → **410**, and `X-Min-Client-Version` on `/api/auth/me`.
3. **Web** — deploy SPA build whose `APP_CLIENT_VERSION` ≥ server `MIN_CLIENT_VERSION`.
4. **iOS** — release/TestFlight build with matching `ClientVersion.current`.

Reversing order (client before server) can cause transient errors; clients retry after deploy.

## 3. Verification

- **Web:** sign in, mutate data, confirm network uses `/api/snapshot` + `POST /api/events` only (no `PUT /api/workspace`).
- **iOS:** same; confirm clinical actions include GPS on wire rows. With the app unlocked, confirm a long-lived `GET /api/events/stream` connection is opened (server logs or proxy) and that a change from the web triggers a catch-up pull within about a second. Toggle airplane mode on a mutation to confirm the event is queued under Application Support and retries after reconnect (foreground refresh also drains the outbox).
- **Visit audit on iOS:** after check-in / complete / **Add note** on device A, sign in on device B (or reinstall) and confirm Today shows the same in-progress/completed state and **Visit log** text once events have synced. Local check-ins that have not yet POSTed are preserved across pull (merged with server replay).
- **Shared reducers:** `npx vitest run src/test/eventFixtures.test.ts` and `xcodebuild test` (see `EventFixtureTests` in `RouteCareTests`) both read `specs/event-fixtures/*.json` — add a fixture when adding an `EventKind` so TS and Swift stay aligned.
- **Chain:** `cd server && pnpm run audit:verify -- <userId>` (or documented flags) against production read replica when allowed.

## 4. Rollback

- Keep previous server image that still accepted `PUT /api/workspace` only if you must revert **server** without reverting clients; mixed generations are painful—prefer fixing forward and bumping `MIN_CLIENT_VERSION` only when all clients are ready.

## 5. Communications

- Announce **forced upgrade** if `MIN_CLIENT_VERSION` jumps: web shows `UpdateRequired`, iOS shows `UpdateRequiredView` on `/api/auth/me` header mismatch or 410 from removed routes.
