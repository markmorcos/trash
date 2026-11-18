// The WhatsApp connection: the real one (Baileys, a linked device like WhatsApp Web)
// and a fake one that integration and screenshot tests drive over HTTP.
import makeWASocket, { Browsers, DEFAULT_CONNECTION_CONFIG, DisconnectReason, fetchLatestWaWebVersion, type WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import type postgres from "postgres";
import { usePostgresAuthState } from "./auth-store";
import { CODE_EXPIRED, LogRing, chooseVersion, codeExpired, describeDisconnect, needsFreshSession, refusedMessage, type WaVersion } from "./pairing";

export type LinkState = "starting" | "unlinked" | "pairing" | "linked";

export interface Problem {
  code: number | null;
  reason: string;
  at: string;
}

export interface TransportStatus {
  state: LinkState;
  /** linked number, digits only */
  me: string | null;
  /** pairing code while linking */
  code: string | null;
  error: string | null;
  /** last time the connection dropped, and why (status code and reason only) */
  lastProblem: Problem | null;
  /** recent library log lines (text only, numbers masked) */
  log?: string[];
}

export interface Group {
  id: string;
  name: string;
}

export interface Transport {
  status(): TransportStatus;
  start(): Promise<void>;
  /** Ask WhatsApp for a link code for this number (digits, with country code). Replaces an earlier code. */
  link(phone: string): Promise<string>;
  groups(): Promise<Group[]>;
  send(jid: string, text: string): Promise<void>;
  unlink(): Promise<void>;
  stop(): Promise<void>;
  onLinked(fn: () => void): void;
}

const digits = (jid: string | undefined | null) => (jid ? jid.split("@")[0].split(":")[0] : null);

/**
 * Shared pairing bookkeeping: a code is shown only while it can still work, i.e. for
 * 3 minutes and only while the connection that requested it stays open.
 */
abstract class PairingTracker {
  protected st: TransportStatus = { state: "starting", me: null, code: null, error: null, lastProblem: null };
  private issuedAt = 0;
  private socketClosedAt: number | null = null;
  protected now(): number {
    return Date.now();
  }
  protected issued(code: string) {
    this.issuedAt = this.now();
    this.socketClosedAt = null;
    this.st = { ...this.st, state: "pairing", me: null, code, error: null };
  }
  protected socketClosed(code: number | undefined) {
    this.socketClosedAt = this.now();
    this.st = { ...this.st, lastProblem: { code: code ?? null, reason: describeDisconnect(code), at: new Date().toISOString() } };
  }
  protected refused(err: unknown): never {
    const reason = refusedMessage(err);
    const code = (err as { data?: unknown }).data;
    this.st = {
      ...this.st,
      state: "unlinked",
      code: null,
      error: reason,
      lastProblem: { code: typeof code === "number" ? code : null, reason, at: new Date().toISOString() },
    };
    ring.push(reason);
    throw new Error(reason);
  }
  status(): TransportStatus {
    if (this.st.state === "pairing" && codeExpired(this.issuedAt, this.now(), this.socketClosedAt)) {
      this.st = { ...this.st, state: "unlinked", code: null, error: CODE_EXPIRED };
    }
    return { ...this.st, log: ring.all() };
  }
}

export const ring = new LogRing();

// Baileys logs objects that can include message data; keep only its short text lines.
// info and up go to the ring (shown masked on the Settings card); warn and up also to stdout.
const logger = pino({
  level: "info",
  hooks: {
    logMethod(args, method, level) {
      const text = args.find((a): a is string => typeof a === "string") ?? "(details hidden)";
      ring.push(text);
      if (level >= 40) method.apply(this, [`whatsapp(baileys): ${text}`]);
    },
  },
});

let cachedVersion: { version: WaVersion; source: "latest" | "bundled"; at: number } | null = null;
async function waVersion(): Promise<{ version: WaVersion; source: "latest" | "bundled" }> {
  if (cachedVersion && Date.now() - cachedVersion.at < 6 * 3600_000) return cachedVersion;
  let fetched: { version: number[] } | null = null;
  try {
    fetched = await fetchLatestWaWebVersion({});
  } catch {
    fetched = null;
  }
  // the bundled default is used only if WhatsApp's version lookup fails
  const v = chooseVersion(fetched, DEFAULT_CONNECTION_CONFIG.version as WaVersion);
  cachedVersion = { ...v, at: Date.now() };
  console.log(`whatsapp: using WhatsApp Web ${v.version.join(".")} (${v.source})`);
  return v;
}

/** The real thing. Only sends; incoming messages are never read or stored. */
export class BaileysTransport extends PairingTracker implements Transport {
  private sock: WASocket | null = null;
  private linkedHandlers: (() => void)[] = [];
  private stopping = false;
  private auth!: Awaited<ReturnType<typeof usePostgresAuthState>>;
  /** resolves once the current connection is ready to ask for a link code */
  private ready: Promise<void> = Promise.resolve();
  private markReady: () => void = () => {};

  constructor(private sql: postgres.Sql) {
    super();
  }

  onLinked(fn: () => void) {
    this.linkedHandlers.push(fn);
  }

  async start() {
    this.auth = await usePostgresAuthState(this.sql);
    await this.connect();
  }

  private async connect() {
    this.ready = new Promise((r) => (this.markReady = r));
    const { version } = await waVersion();
    const sock = makeWASocket({
      version,
      auth: this.auth.state,
      browser: Browsers.macOS("Chrome"),
      logger,
      markOnlineOnConnect: false,
      // Recent history only (Baileys' default). Turning sync off entirely stops Baileys
      // learning WhatsApp's LID contact mappings, which breaks sessions and group sends.
      // The bridge registers no message handlers, so nothing from it is read or stored.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    sock.ev.on("creds.update", () => void this.auth.saveCreds());
    sock.ev.on("connection.update", (u) => {
      if (u.connection === "open") {
        this.st = { ...this.st, state: "linked", me: digits(sock.user?.id), code: null, error: null };
        console.log("whatsapp: linked");
        this.linkedHandlers.forEach((f) => f());
      }
      if (u.qr) {
        // the server offered pairing: this connection can now request a code
        this.markReady();
        if (this.st.state === "starting") this.st = { ...this.st, state: "unlinked" };
      }
      if (u.connection === "close") {
        if (this.sock !== sock || this.stopping) return;
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        this.socketClosed(code);
        ring.push(`connection closed: ${describeDisconnect(code)}`);
        console.log(`whatsapp: connection closed: ${describeDisconnect(code)}`);
        if (code === DisconnectReason.loggedOut) {
          this.st = { ...this.st, state: "unlinked", me: null, code: null, error: "Logged out on the phone. Link again." };
          void this.auth.clear().then(() => this.start());
          return;
        }
        if (this.st.state === "linked") this.st = { ...this.st, state: "starting" };
        setTimeout(() => void this.connect(), code === DisconnectReason.restartRequired ? 0 : 3000);
      }
    });
  }

  async link(phone: string) {
    if (!this.sock) throw new Error("not started");
    if (this.auth.state.creds.registered) throw new Error("already linked");
    // a code was asked for before: start over with fresh credentials and a new connection
    if (needsFreshSession(this.auth.state.creds)) await this.freshSession();
    await Promise.race([this.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("WhatsApp didn't answer. Try again.")), 20_000))]);
    let code: string;
    try {
      code = await this.sock!.requestPairingCode(phone);
    } catch (e) {
      this.refused(e);
    }
    this.issued(code);
    return code;
  }

  private async freshSession() {
    const old = this.sock;
    this.sock = null;
    old?.end(undefined);
    await this.auth.clear();
    this.auth = await usePostgresAuthState(this.sql);
    await this.connect();
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
    const old = this.sock;
    this.sock = null;
    await old?.logout().catch(() => {});
    old?.end(undefined);
    await this.auth.clear();
    this.st = { ...this.st, state: "unlinked", me: null, code: null, error: null };
    await this.start();
  }

  async stop() {
    this.stopping = true;
    this.sock?.end(undefined);
  }
}

/**
 * Test double: same behaviour from the outside, no network. Its "linked" flag is
 * kept in wa_auth so a restart stays linked, like the real login. `skewMs` moves
 * its clock forward so tests can expire codes without waiting.
 */
export class FakeTransport extends PairingTracker implements Transport {
  sent: { jid: string; text: string; at: string }[] = [];
  failNext = 0;
  skewMs = 0;
  issuedCount = 0;
  groupList: Group[] = [
    { id: "120363000000000001@g.us", name: "🏠 Flat" },
    { id: "120363000000000002@g.us", name: "Family" },
  ];
  private linkedHandlers: (() => void)[] = [];
  private pendingPhone = "";

  constructor(private sql: postgres.Sql) {
    super();
  }

  protected override now() {
    return Date.now() + this.skewMs;
  }
  onLinked(fn: () => void) {
    this.linkedHandlers.push(fn);
  }

  async start() {
    const [r] = await this.sql`select value from wa_auth where key = 'fake-me'`;
    this.st = r ? { ...this.st, state: "linked", me: r.value, code: null, error: null } : { ...this.st, state: "unlinked", me: null, code: null };
    if (r) this.linkedHandlers.forEach((f) => f());
  }
  /** how many fresh sessions linking has started (the real one reconnects with new keys) */
  sessions = 1;
  private codeAsked = false;
  refuseNext = false;
  async link(phone: string) {
    if (this.refuseNext) {
      this.refuseNext = false;
      this.refused(Object.assign(new Error("bad-request"), { data: 400 }));
    }
    if (needsFreshSession({ me: this.codeAsked || undefined, registered: false })) this.sessions++;
    this.codeAsked = true;
    this.issuedCount++;
    const code = this.issuedCount === 1 ? "TRSH4CD9" : `TRSH4CD${this.issuedCount}`.slice(0, 8);
    this.pendingPhone = phone;
    this.issued(code);
    return code;
  }
  /** What entering the code on the phone does. */
  async completeLink() {
    await this.sql`insert into wa_auth (key, value) values ('fake-me', ${this.pendingPhone || "491700000000"})
      on conflict (key) do update set value = excluded.value`;
    this.st = { ...this.st, state: "linked", me: this.pendingPhone || "491700000000", code: null, error: null };
    this.linkedHandlers.forEach((f) => f());
  }
  /** The connection dropping, as WhatsApp would close it. */
  closeSocket(code = 428) {
    this.socketClosed(code);
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
    this.st = { state: "unlinked", me: null, code: null, error: null, lastProblem: null };
    this.issuedCount = 0;
    this.skewMs = 0;
    this.sessions = 1;
    this.codeAsked = false;
    this.refuseNext = false;
  }
  async stop() {}
}
