import type { ClientMessage, ErrorCode } from "../shared/messages";
import {
  BIN_LABELS,
  assignWeek,
  binsOf,
  currentWeek,
  validateOverride,
  type BinId,
  type Config,
  type Override,
} from "../shared/rotation";
import { loadConfig, mutate, sql } from "./db";
import { pushTo } from "./push";

export class ActionError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

const nameOf = (c: Config, id: string | null) => c.people.find((p) => p.id === id)?.name ?? "Someone";
const fmt = (week: string) =>
  new Date(week + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

async function weekOverrides(week: string): Promise<Override[]> {
  const rows = await sql`select id, to_char(week, 'YYYY-MM-DD') as week, kind, person, other, created_by
    from overrides where week = ${week} order by created_at`;
  return rows.map((r) => ({ id: r.id, week: r.week, kind: r.kind, person: r.person, other: r.other, createdBy: r.created_by }));
}

const OVERRIDE_MESSAGES: Record<string, string> = {
  unknown_person: "That person isn't in the house list.",
  already_away: "You're already marked away that week.",
  not_on_rota: "You're not on the rota that week.",
  same_person: "Pick someone other than yourself.",
  partner_away: "They're away that week. Undo their away week first.",
  already_swapped: "One of you already has a swap that week. Undo it first.",
};

/** Apply one client intent for `me`. Throws ActionError on a rule violation. */
export async function handle(msg: ClientMessage, me: string): Promise<void> {
  const { config } = await loadConfig();
  const now = currentWeek(new Date(), config.timezone);

  switch (msg.type) {
    case "hello":
      return;

    case "checkoff": {
      if (msg.week !== now) throw new ActionError("not_allowed", "You can only tick bins for this week.");
      const a = assignWeek(config, await weekOverrides(now), now);
      if (!binsOf(a, me).includes(msg.bin))
        throw new ActionError("not_allowed", `${BIN_LABELS[msg.bin]} isn't yours this week.`);
      await mutate((tx) => tx`insert into checkoffs (week, bin, person, done_by)
        values (${now}, ${msg.bin}, ${me}, ${me}) on conflict (week, bin) do nothing`);
      return;
    }

    case "uncheckoff": {
      if (msg.week !== now) throw new ActionError("not_allowed", "Past weeks are closed.");
      const removed = await mutate((tx) => tx`delete from checkoffs
        where week = ${now} and bin = ${msg.bin} and (person = ${me} or done_by = ${me}) returning bin`);
      if (!removed.length) throw new ActionError("not_found", "Nothing to undo.");
      return;
    }

    case "override": {
      if (msg.week < now) throw new ActionError("not_allowed", "That week is over.");
      const existing = await weekOverrides(msg.week);
      const err = validateOverride(config, existing, msg.week, msg.kind, me, msg.with ?? null);
      if (err) throw new ActionError(err, OVERRIDE_MESSAGES[err]);
      const before = assignWeek(config, existing, msg.week);
      await mutate((tx) => tx`insert into overrides (week, kind, person, other, created_by)
        values (${msg.week}, ${msg.kind}, ${me}, ${msg.with ?? null}, ${me})`);
      const after = assignWeek(config, await weekOverrides(msg.week), msg.week);
      const when = msg.week === now ? "this week" : `the week of ${fmt(msg.week)}`;
      if (msg.kind === "away") {
        for (const b of after.bins) {
          if (b.covering === me && b.person && !binsOf(before, b.person).includes(b.bin)) {
            await pushTo(b.person, {
              title: "You're covering",
              body: `${nameOf(config, me)} is away ${when}. You have ${BIN_LABELS[b.bin]} too.`,
              tag: `cover-${msg.week}-${b.bin}`,
              url: "/#week",
            });
          }
        }
      } else if (msg.with) {
        const mine = binsOf(after, msg.with).map((b) => BIN_LABELS[b]).join(" and ") || "a rest week";
        await pushTo(msg.with, {
          title: "Swap",
          body: `${nameOf(config, me)} swapped with you for ${when}. You now have ${mine}.`,
          tag: `swap-${msg.week}`,
          url: "/#upcoming",
        });
      }
      return;
    }

    case "undoOverride": {
      const removed = await mutate((tx) => tx`delete from overrides where id = ${msg.id} and week >= ${now} returning id`);
      if (!removed.length) throw new ActionError("not_found", "That change is already gone or in the past.");
      return;
    }

    case "updateConfig": {
      await mutate(async (tx) => {
        const [row] = await tx`select data from config where id = 1 for update`;
        const current = row.data as Config;
        if (current.rev !== msg.baseRev)
          throw new ActionError("stale_config", "Someone changed the settings first. Here is the latest version.");
        const next: Config = { ...current, rev: current.rev + 1 };
        if (msg.lineup) {
          const ids = current.people.map((p) => p.id).sort();
          if (msg.lineup.length !== ids.length || [...msg.lineup].sort().join() !== ids.join())
            throw new ActionError("bad_message", "The lineup must list everyone exactly once.");
          next.anchorWeek = now;
          next.order = msg.lineup;
        }
        if (msg.names) {
          next.people = current.people.map((p) => (msg.names![p.id] ? { ...p, name: msg.names![p.id] } : p));
        }
        await tx`update config set data = ${tx.json(next as never)} where id = 1`;
      });
      return;
    }
  }
}

export type { BinId };
