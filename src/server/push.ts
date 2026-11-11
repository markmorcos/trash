import * as webpush from "web-push";
import { sql } from "./db";

const pub = process.env.VAPID_PUBLIC_KEY;
const priv = process.env.VAPID_PRIVATE_KEY;
export const pushEnabled = Boolean(pub && priv);

if (pushEnabled) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@morcos.tech", pub!, priv!);
} else {
  console.warn("VAPID keys are not set: push notifications are off");
}

export const vapidPublicKey = pub ?? null;

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/** Send to every device of a person. Drops subscriptions the push service says are gone. */
export async function pushTo(person: string, payload: PushPayload): Promise<number> {
  if (!pushEnabled) return 0;
  const subs = await sql`select endpoint, p256dh, auth from push_subscriptions where person = ${person}`;
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 12 * 3600 },
        );
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await sql`delete from push_subscriptions where endpoint = ${s.endpoint}`;
        } else {
          console.error("push failed", person, code ?? err);
        }
      }
    }),
  );
  return sent;
}

export async function hasSubscription(person: string): Promise<boolean> {
  const [r] = await sql`select 1 from push_subscriptions where person = ${person} limit 1`;
  return Boolean(r);
}
