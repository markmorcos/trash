# trash

Who takes which bin this week. A small website for the five of us: four bins rotate, one person rests, Sunday is the last day for every bin, and Monday starts the next rotation. Changes show up live on every phone, and browsers get a Sunday reminder.

Live at https://trash.morcos.tech

## How the rotation works

- Weeks run Monday 00:00 to Sunday 23:59, Europe/Berlin.
- Every Monday everyone moves one bin to the right: Restmüll → Wertstoff → Biomüll → Papier → break → Restmüll.
- The anchor is the week of 9 Nov 2026: Lea, Liz, Mark, Ari, and Francisco on break.
- **Away**: the person on break covers your bin. When more people are away, each extra bin goes to whoever has the fewest bins, nearest to the right, so one person can have two. Earlier covers never move.
- **Swap**: two people trade for one week.
- Overrides change one week only. The rotation carries on after.

The logic is in `src/shared/rotation.ts`. The browser and the server use the same code, and `test/rotation.test.ts` covers it.

## Stack

| Part | What |
| --- | --- |
| Frontend | Svelte 5 + Vite, static build, installable PWA (`public/manifest.webmanifest`, `public/sw.js`) |
| Server | Node 22 `http` + `ws`, one process on port 8080 (`src/server`) |
| Live sync | every change runs in one Postgres transaction that bumps a version and `NOTIFY rota_changed`; every pod `LISTEN`s and pushes the full state to its sockets |
| Data | Postgres; the server creates its tables on startup (`src/server/db.ts`) and seeds the fridge state on first run |
| Push | Web Push with VAPID keys (`web-push`), no Firebase account |
| Schedules | chart `crons[]`: Sunday 18:00 reminder, Monday 00:05 rollover |

### Routes

| Route | For |
| --- | --- |
| `POST /api/login` | house passcode → signed session cookie |
| `POST /api/me` | pick who you are |
| `GET /api/state` | full state |
| `GET /ws` | live socket (`hello`, `checkoff`, `uncheckoff`, `override`, `undoOverride`, `updateConfig`) |
| `/api/push/*` | VAPID key, subscribe, unsubscribe, status |
| `POST /internal/remind`, `/internal/rollover` | CronJobs only, `Authorization: Bearer $CRON_TOKEN` |
| `GET /healthz` | readiness |

## Secrets

`database-secrets` comes from admin provisioning. `app-secrets` comes from the `bootstrap-trash` workflow in `markmorcos-dev/infrastructure`:

| Key | Notes |
| --- | --- |
| `HOUSE_PASSCODE` | from the infra repo secret `TRASH_HOUSE_PASSCODE`; re-run the workflow to change it |
| `SESSION_SECRET` | random; rotating it logs everyone out |
| `CRON_TOKEN` | random |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated once. **Never rotate them**: that breaks every phone's reminders |
| `VAPID_SUBJECT` | contact URL for the push services |

## Development

```bash
cp .env.example .env          # then: npx web-push generate-vapid-keys, paste the keys
docker compose up -d          # Postgres on :5433
npm install
npm run build && npm run dev  # server on :8080 serving dist/web
npm run dev:web               # optional: Vite on :5173 with hot reload, proxying /api and /ws
```

Push works on `localhost` without HTTPS, so you can test reminders in Chrome: turn them on in Settings, then
`curl -X POST -H "Authorization: Bearer dev-cron-token" localhost:8080/internal/remind`.

## Tests

Every change ships with unit, integration and visual tests. CI runs all three before it deploys.

| Suite | Command | What it covers |
| --- | --- | --- |
| Unit | `npm run test:unit` | rotation rules, Berlin weeks and DST, overrides, validation, sessions, passcode limits, message schemas, formatting |
| Integration | `npm run test:integration` | two real server processes ("pods") on one Postgres: login, socket auth, live sync across pods via NOTIFY, rule errors, swaps/away, stale settings, reminder and rollover jobs, push subscriptions, reconnect |
| Visual | `npm run test:visual` | Playwright screenshots of every screen at phone size, light and dark (`e2e/__screenshots__`) |
| Types | `npm run check` | TypeScript + Svelte |

Integration and visual tests need a disposable database:

```bash
export TEST_DATABASE_URL=postgres://trash_app:dev@localhost:5433/trash_test   # wiped on every run
npm test && npm run test:visual
```

The server's clock is pinned to Wed 11 Nov 2026 in tests (`TRASH_TEST_MODE=1`, `TRASH_FAKE_NOW`), so the screenshots always show the same week.

**Changing the UI on purpose:** run `npm run test:visual:update` and commit the new screenshots. CI renders inside the
Playwright 1.63 image; if its screenshots differ from yours, run the workflow manually with **update_snapshots** ticked
and it regenerates and commits them.

## Deploy

Push to `main`. CI runs the tests and dispatches `deploy-trash` to the infrastructure repo, which builds arm64 + amd64 images and runs `helm upgrade` with `deployment.yaml`.
