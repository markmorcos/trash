// Drops every app table so the next server start migrates and seeds from scratch.
// Refuses to run against anything that doesn't look like a test database.
import postgres from "postgres";

export async function resetDb(url = process.env.TEST_DATABASE_URL) {
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  if (!/test|localhost|127\.0\.0\.1/.test(url)) throw new Error(`refusing to reset a non-test database: ${url}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`drop table if exists config, overrides, checkoffs, week_history, push_subscriptions, notifications_sent cascade`;
  await sql.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await resetDb();
  console.log("test database reset");
}
