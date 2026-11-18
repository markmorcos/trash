// The app's side of WhatsApp: proxies the bridge (cluster-internal) and records
// group choices as events. Never exposes the bridge's login keys.
import { z } from "zod";
import type { EventData } from "../shared/events";
import { append, loadHouse, outboxSummary, queuePost, sql } from "./db";
import { ActionError } from "./actions";

const BRIDGE = process.env.WA_BRIDGE_URL ?? "http://trash-whatsapp-service.trash.svc.cluster.local:8081";

interface BridgeStatus {
  lock: boolean;
  state: "starting" | "unlinked" | "pairing" | "linked";
  me: string | null;
  code: string | null;
  error: string | null;
  lastProblem: { code: number | null; reason: string; at: string } | null;
  groups: { id: string; name: string }[];
}

async function bridge<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(BRIDGE + path, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${process.env.CRON_TOKEN ?? ""}`, "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init?.method === "POST" ? 30_000 : 4000),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new ActionError("not_allowed", (b as { error?: string }).error ?? `WhatsApp bridge error (${r.status})`);
  return b as T;
}

/** "+49 ••• ••• 678": enough to recognise the number, not enough to copy it. */
export const maskNumber = (digits: string | null) => (digits ? `+${digits.slice(0, 2)} ••• ••• ${digits.slice(-3)}` : null);

export async function whatsappStatus() {
  const h = await loadHouse();
  let b: BridgeStatus | null = null;
  try {
    b = await bridge<BridgeStatus>("/status");
  } catch {
    b = null;
  }
  return {
    bridge: b ? (b.lock ? "up" : "starting") : "unreachable",
    state: b?.state ?? null,
    me: maskNumber(b?.me ?? null),
    code: b?.code ?? null,
    error: b?.error ?? null,
    lastProblem: b?.lastProblem ?? null,
    groups: b?.groups ?? [],
    target: h.whatsapp,
    outbox: await outboxSummary(),
  };
}

const Phone = z.object({ phone: z.string().max(30) });
const Group = z.object({ jid: z.string().regex(/^[\w.-]+@g\.us$/) });

export async function linkWhatsapp(input: unknown) {
  const { phone } = Phone.parse(input);
  return bridge<{ code: string }>("/link", { method: "POST", body: { phone } });
}

export async function unlinkWhatsapp() {
  return bridge("/unlink", { method: "POST" });
}

/** Choose the group; only a group the linked number is actually in. */
export async function setWhatsappGroup(me: string, input: unknown) {
  const { jid } = Group.parse(input);
  const st = await bridge<BridgeStatus>("/status");
  const g = st.groups.find((x) => x.id === jid);
  if (!g) throw new ActionError("not_found", "That group isn't one the linked number is in.");
  await append(me, () => [{ type: "whatsapp.group_set", jid: g.id, name: g.name } satisfies EventData]);
}

export async function turnWhatsappOff(me: string) {
  await append(me, (h) => (h.whatsapp?.enabled ? [{ type: "whatsapp.turned_off" } satisfies EventData] : []));
}

export async function sendTestPost(me: string) {
  const h = await loadHouse();
  const name = h.config?.people.find((p) => p.id === me)?.name ?? "someone";
  const ok = await queuePost(sql, { kind: "test", text: `🧪 Test from the trash rota (sent by ${name})` });
  if (!ok) throw new ActionError("not_allowed", "Pick a group first.");
}
