# trash

House trash rota: Svelte 5 PWA + Node `http`/`ws` server + Postgres. See README.md.

## Rules for every change

- Every change ships with **unit tests, an integration test, and visual tests**. No exceptions.
  - Unit: `test/unit/*.test.ts` (vitest)
  - Integration: `test/integration/*.test.ts`, real server processes + Postgres (`TEST_DATABASE_URL`)
  - Visual: `e2e/*.spec.ts` Playwright screenshots, light + dark; update baselines with `npm run test:visual:update` and commit them
- Before pushing: `npm run check && npm test && npm run test:visual` must pass.
- Rotation logic lives only in `src/shared/rotation.ts` (shared by browser and server).
- Never regenerate VAPID keys; never commit secrets.
