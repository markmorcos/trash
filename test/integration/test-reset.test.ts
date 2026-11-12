// The screenshot tests' reset wipes the event log, so it must exist only in test mode.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDb } from "../support/reset-db.mjs";
import { connect, cron, loginAs, startPod, type Pod } from "../support/server";

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("test-only reset", () => {
  let sql: postgres.Sql;
  const pods: Pod[] = [];
  beforeAll(async () => {
    await resetDb(dbUrl);
    sql = postgres(dbUrl!, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await Promise.all(pods.map((p) => p.stop()));
    await sql?.end();
  });

  it("puts the house back to the seed in test mode", async () => {
    const pod = await startPod();
    pods.push(pod);
    const liz = await connect(pod, await loginAs(pod, "liz"));
    liz.send({ type: "checkoff", week: "2026-11-09", bin: "wert" });
    await liz.next("state", (m) => m.state.takeouts.length === 1);
    expect((await cron(pod, "/internal/test/reset")).status).toBe(200);
    const m = await liz.next("state", (x) => x.state.version === 2);
    expect(m.state.takeouts).toEqual([]);
    expect((await sql`select type from events order by id`).map((r) => r.type)).toEqual(["house.seeded", "away.marked"]);
    liz.close();
  });

  it("does not exist outside test mode", async () => {
    const pod = await startPod({ TRASH_TEST_MODE: "0" });
    pods.push(pod);
    expect((await cron(pod, "/internal/test/reset")).status).toBe(404);
    const [{ n }] = await sql`select count(*)::int as n from events`;
    expect(n).toBe(2);
  });
});
