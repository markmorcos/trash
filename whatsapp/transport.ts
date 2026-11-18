// The WhatsApp connection: the real one (Baileys, a linked device like WhatsApp Web)
// and a fake one that integration and screenshot tests drive over HTTP.
import makeWASocket, { Browsers, DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import type postgres from "postgres";
import { usePostgresAuthState } from "./auth-store";

export type LinkState = "starting" | "unlinked" | "pairing" | "linked";

export interface TransportStatus {
  state: LinkState;
  /** linked number, digits only */
  me: string | null;
  /** pairing code while linking */
  code: string | null;
  error: string | null;
}

export interface Group {
  id: string;
  name: string;
}

export interface Transport {
  status(): TransportStatus;
  start(): Promise<void>;
  /** Ask WhatsApp for a link code for this number (digits, with country code). */
  link(phone: string): Promise<string>;
  groups(): Promise<Group[]>;
  send(jid: string, text: string): Promise<void>;
  unlink(): Promise<void>;
  stop(): Promise<void>;
  onLinked(fn: () => void): void;
}

const digits = (jid: string | undefined | null) => (jid ? jid.split("@")[0].split(":")[0] : null);

/** The real thing. Only sends; incoming messages are never read or stored. */
export class BaileysTransport implements Transport {
  private sock: WASocket | null = null;
  private st: TransportStatus = { state: "starting", me: null, code: null, error: null };
  private linkedHandlers: (() => void)[] = [];
  private stopping = false;
  private auth!: Awaited<ReturnType<typeof usePostgresAuthState>>;

  constructor(private sql: postgres.Sql) {}

  status() {
    return { ...this.st };
  }
  onLinked(fn: () => void) {
    this.linkedHandlers.push(fn);
  }

  async start() {
    this.auth = await usePostgresAuthState(this.sql);
    this.connect();
  }

  private connect() {
    const sock = makeWASocket({
      auth: this.auth.state,
      browser: Browsers.ubuntu("Chrome"),
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    sock.ev.on("creds.update", () => void this.auth.saveCreds());
    sock.ev.on("connection.update", (u) => {
      if (u.connection === "open") {
        this.st = { state: "linked", me: digits(sock.user?.id), code: null, error: null };
        console.log("whatsapp: linked");
        this.linkedHandlers.forEach((f) => f());
      }
      if (u.qr && this.st.state !== "pairing") this.st = { ...this.st, state: "unlinked" };
      if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (this.stopping) return;
        if (code === DisconnectReason.loggedOut) {
          console.log("whatsapp: logged out; waiting to be linked again");
          void this.auth.clear().then(() => this.start());
          this.st = { state: "unlinked", me: null, code: null, error: "Logged out on the phone. Link again." };
          return;
        }
        console.log(`whatsapp: connection closed (${code ?? "unknown"}), reconnecting`);
        setTimeout(() => this.connect(), code === DisconnectReason.restartRequired ? 0 : 3000);
      }
    });
  }

  async link(phone: string) {
    if (!this.sock) throw new Error("not started");
    if (this.auth.state.creds.registered) throw new Error("already linked");
    const code = await this.sock.requestPairingCode(phone);
    this.st = { state: "pairing", me: null, code, error: null };
    return code;
  }

  async groups() {
    if (!this.sock || this.st.state !== "linked") return [];
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all)
      .map((g) => ({ id: g.id, name: g.subject }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async send(jid: string, text: string) {
    if (!this.sock || this.st.state !== "linked") throw new Error("not linked");
    await this.sock.sendMessage(jid, { text });
  }

  async unlink() {
    await this.sock?.logout().catch(() => {});
    await this.auth.clear();
    this.st = { state: "unlinked", me: null, code: null, error: null };
    this.sock?.end(undefined);
    await this.start();
  }

  async stop() {
    this.stopping = true;
    this.sock?.end(undefined);
  }
}

/**
 * Test double: same behaviour from the outside, no network. Its "linked" flag is
 * kept in wa_auth so a restart stays linked, like the real login.
 */
export class FakeTransport implements Transport {
  st: TransportStatus = { state: "starting", me: null, code: null, error: null };
  sent: { jid: string; text: string; at: string }[] = [];
  failNext = 0;
  groupList: Group[] = [
    { id: "120363000000000001@g.us", name: "🏠 Flat" },
    { id: "120363000000000002@g.us", name: "Family" },
  ];
  private linkedHandlers: (() => void)[] = [];

  constructor(private sql: postgres.Sql) {}

  status() {
    return { ...this.st };
  }
  onLinked(fn: () => void) {
    this.linkedHandlers.push(fn);
  }

  async start() {
    const [r] = await this.sql`select value from wa_auth where key = 'fake-me'`;
    this.st = r ? { state: "linked", me: r.value, code: null, error: null } : { state: "unlinked", me: null, code: null, error: null };
    if (r) this.linkedHandlers.forEach((f) => f());
  }
  async link(phone: string) {
    this.st = { state: "pairing", me: null, code: "TRSH4CD9", error: null };
    this.pendingPhone = phone;
    return "TRSH4CD9";
  }
  private pendingPhone = "";
  /** What entering the code on the phone does. */
  async completeLink() {
    await this.sql`insert into wa_auth (key, value) values ('fake-me', ${this.pendingPhone || "491700000000"})
      on conflict (key) do update set value = excluded.value`;
    this.st = { state: "linked", me: this.pendingPhone || "491700000000", code: null, error: null };
    this.linkedHandlers.forEach((f) => f());
  }
  async groups() {
    return this.st.state === "linked" ? this.groupList : [];
  }
  async send(jid: string, text: string) {
    if (this.st.state !== "linked") throw new Error("not linked");
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("fake send failure");
    }
    this.sent.push({ jid, text, at: new Date().toISOString() });
  }
  async unlink() {
    await this.sql`delete from wa_auth`;
    this.st = { state: "unlinked", me: null, code: null, error: null };
  }
  async stop() {}
}
