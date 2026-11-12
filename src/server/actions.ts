import type { House } from "../shared/events";
import { takeoutsFor } from "../shared/events";
import type { ClientMessage, ErrorCode } from "../shared/messages";
import { BIN_LABELS, assignWeek, binsOf, currentWeek, validateOverride, type BinId, type Config } from "../shared/rotation";
import { now as clockNow } from "./clock";
import { append, loadConfig, loadHouse } from "./db";
import { pushTo } from "./push";

export class ActionError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

const nameOf = (c: Config, id: string | null) => c.people.find((p) => p.id === id)?.name ?? "Someone";
const fmt = (week: string) =>
  new Date(week + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const OVERRIDE_MESSAGES: Record<string, string> = {
  unknown_person: "That person isn't in the house list.",
  already_away: "You're already marked away that week.",
  not_on_rota: "You're not on the rota that week.",
  same_person: "Pick someone other than yourself.",
  partner_away: "They're away that week. Undo their away week first.",
  already_swapped: "One of you already has a swap that week. Undo it first.",
};

const cfg = (h: House) => {
  if (!h.config) throw new ActionError("server_error", "The house isn't set up yet.");
  return h.config;
};

/** Apply one client intent for `me` by appending events. Throws ActionError on a rule violation. */
export async function handle(msg: ClientMessage, me: string): Promise<void> {
  const tz = (await loadConfig()).config.timezone;
  const now = currentWeek(clockNow(), tz);

  switch (msg.type) {
    case "hello":
      return;

    case "checkoff": {
      // Allowed as often as needed: bins can fill up more than once a week.
      await append(me, (h) => {
        if (msg.week !== now) throw new ActionError("not_allowed", "You can only tick bins for this week.");
        const a = assignWeek(cfg(h), h.overrides, now);
        if (!binsOf(a, me).includes(msg.bin)) throw new ActionError("not_allowed", `${BIN_LABELS[msg.bin]} isn't yours this week.`);
        return [{ type: "bin.taken_out", week: now, bin: msg.bin, person: me }];
      });
      return;
    }

    case "uncheckoff": {
      await append(me, (h) => {
        if (msg.week !== now) throw new ActionError("not_allowed", "Past weeks are closed.");
        const mine = takeoutsFor(h.takeouts, now, msg.bin).filter((t) => t.person === me);
        const last = mine[mine.length - 1];
        if (!last) throw new ActionError("not_found", "Nothing to undo.");
        return [{ type: "bin.take_out_undone", takeoutId: last.id }];
      });
      return;
    }

    case "override": {
      let before: ReturnType<typeof assignWeek> | null = null;
      let config: Config | null = null;
      await append(me, (h) => {
        config = cfg(h);
        if (msg.week < now) throw new ActionError("not_allowed", "That week is over.");
        const err = validateOverride(config, h.overrides, msg.week, msg.kind, me, msg.with ?? null);
        if (err) throw new ActionError(err, OVERRIDE_MESSAGES[err]);
        before = assignWeek(config, h.overrides, msg.week);
        return msg.kind === "away"
          ? [{ type: "away.marked", week: msg.week, person: me }]
          : [{ type: "swap.made", week: msg.week, person: me, other: msg.with! }];
      });
      await notifyOverride(msg, me, config!, before!);
      return;
    }

    case "undoOverride": {
      await append(me, (h) => {
        const o = h.overrides.find((x) => x.id === msg.id);
        if (!o || o.week < now) throw new ActionError("not_found", "That change is already gone or in the past.");
        return [{ type: "change.undone", changeId: o.id }];
      });
      return;
    }

    case "updateConfig": {
      await append(me, (h) => {
        const current = cfg(h);
        if (current.rev !== msg.baseRev)
          throw new ActionError("stale_config", "Someone changed the settings first. Here is the latest version.");
        const out: ({ type: "rotation.set"; anchorWeek: string; order: string[] } | { type: "people.renamed"; names: Record<string, string> })[] = [];
        if (msg.lineup) {
          const ids = current.people.map((p) => p.id).sort();
          if (msg.lineup.length !== ids.length || [...msg.lineup].sort().join() !== ids.join())
            throw new ActionError("bad_message", "The lineup must list everyone exactly once.");
          out.push({ type: "rotation.set", anchorWeek: now, order: msg.lineup });
        }
        if (msg.names) {
          const changed = Object.fromEntries(
            Object.entries(msg.names).filter(([id, n]) => current.people.some((p) => p.id === id && p.name !== n)),
          );
          if (Object.keys(changed).length) out.push({ type: "people.renamed", names: changed });
        }
        return out;
      });
      return;
    }
  }
}

/** Tell whoever now covers a bin, or the swap partner. */
async function notifyOverride(
  msg: Extract<ClientMessage, { type: "override" }>,
  me: string,
  config: Config,
  before: ReturnType<typeof assignWeek>,
) {
  const h = await loadHouse();
  const after = assignWeek(config, h.overrides, msg.week);
  const now = currentWeek(clockNow(), config.timezone);
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
    const theirs = binsOf(after, msg.with).map((b) => BIN_LABELS[b]).join(" and ") || "a rest week";
    await pushTo(msg.with, {
      title: "Swap",
      body: `${nameOf(config, me)} swapped with you for ${when}. You now have ${theirs}.`,
      tag: `swap-${msg.week}`,
      url: "/#upcoming",
    });
  }
}

export type { BinId };
