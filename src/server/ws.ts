import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage, type ServerMessage } from "../shared/messages";
import { currentWeek } from "../shared/rotation";
import { ActionError, handle } from "./actions";
import { readSession } from "./auth";
import { now } from "./clock";
import { loadConfig, loadState, sql } from "./db";

interface Client {
  ws: WebSocket;
  person: string;
  alive: boolean;
}

const clients = new Set<Client>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

const send = (ws: WebSocket, m: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

async function stateMessage(): Promise<ServerMessage> {
  const { config } = await loadConfig();
  return { type: "state", state: await loadState(currentWeek(now(), config.timezone)) };
}

function presence() {
  const people = [...new Set([...clients].map((c) => c.person))];
  for (const c of clients) send(c.ws, { type: "presence", people });
}

let pending: Promise<void> | null = null;
/** Send the full state to every socket on this pod (coalesces bursts of NOTIFYs). */
export function broadcast() {
  if (pending) return pending;
  pending = (async () => {
    await new Promise((r) => setTimeout(r, 30));
    pending = null;
    const msg = JSON.stringify(await stateMessage());
    for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  })().catch((e) => {
    pending = null;
    console.error("broadcast failed", e);
  });
  return pending;
}

export let listening = false;

export async function attach(server: Server) {
  await sql.listen(
    "rota_changed",
    () => void broadcast(),
    () => {
      listening = true;
      // after a reconnect to Postgres we may have missed changes
      void broadcast();
    },
  );

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return socket.destroy();
    const s = readSession(req);
    if (!s?.p) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, person: s.p!, alive: true };
      clients.add(client);
      ws.on("pong", () => (client.alive = true));
      ws.on("close", () => {
        clients.delete(client);
        presence();
      });
      ws.on("message", async (raw) => {
        let parsed: ClientMessage;
        try {
          parsed = ClientMessage.parse(JSON.parse(raw.toString()));
        } catch {
          return send(ws, { type: "error", code: "bad_message", message: "That message didn't make sense." });
        }
        try {
          await handle(parsed, client.person);
          if (parsed.type === "hello") send(ws, await stateMessage());
        } catch (e) {
          if (e instanceof ActionError) {
            send(ws, { type: "error", code: e.code, message: e.message });
            if (e.code === "stale_config") send(ws, await stateMessage());
          } else {
            console.error("action failed", parsed.type, e);
            send(ws, { type: "error", code: "server_error", message: "Something went wrong on the server. Try again." });
          }
        }
      });
      presence();
    });
  });

  const ping = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 25_000);
  ping.unref();
}

/** Close every socket with "service restart" so phones reconnect to the new pod at once. */
export function closeAll() {
  for (const c of clients) c.ws.close(1012, "restarting");
}
