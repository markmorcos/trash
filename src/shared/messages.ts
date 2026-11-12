import { z } from "zod";
import { BINS } from "./rotation";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const personId = z.string().min(1).max(40);

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), lastVersion: z.number().int().nonnegative().optional() }),
  /** "I took it out" — can be sent several times a week */
  z.object({ type: z.literal("checkoff"), week: date, bin: z.enum(BINS) }),
  /** undoes my latest take-out of this bin this week */
  z.object({ type: z.literal("uncheckoff"), week: date, bin: z.enum(BINS) }),
  z.object({
    type: z.literal("override"),
    week: date,
    kind: z.enum(["away", "swap"]),
    with: personId.optional(),
  }),
  /** id of the away.marked / swap.made event to undo */
  z.object({ type: z.literal("undoOverride"), id: z.string().regex(/^\d{1,18}$/) }),
  z.object({
    type: z.literal("updateConfig"),
    baseRev: z.number().int(),
    /** New base lineup for the current week (person ids, bins first). */
    lineup: z.array(personId).optional(),
    names: z.record(personId, z.string().trim().min(1).max(30)).optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type ErrorCode =
  | "bad_message"
  | "not_allowed"
  | "stale_config"
  | "not_found"
  | "unknown_person"
  | "already_away"
  | "not_on_rota"
  | "same_person"
  | "partner_away"
  | "already_swapped"
  | "server_error";

export type ServerMessage =
  | { type: "state"; state: import("./rotation").State }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "presence"; people: string[] };
