import { addDays, parseDate } from "../../shared/rotation";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function day(date: string): string {
  const d = new Date(parseDate(date));
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export function range(week: string): string {
  const a = new Date(parseDate(week));
  const b = new Date(parseDate(addDays(week, 6)));
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${MON[b.getUTCMonth()]}`
    : `${day(week)} – ${day(addDays(week, 6))}`;
}

export function list(xs: string[]): string {
  return xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs.at(-1) : (xs[0] ?? "");
}

export const BIN_COLORS: Record<string, string> = {
  rest: "var(--rest)",
  wert: "var(--wert)",
  bio: "var(--bio)",
  papier: "var(--papier)",
};
