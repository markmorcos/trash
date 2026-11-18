<script lang="ts">
  import { app, api, toast } from "../lib/app.svelte";

  interface Status {
    bridge: "up" | "starting" | "unreachable";
    state: "starting" | "unlinked" | "pairing" | "linked" | null;
    me: string | null;
    code: string | null;
    error: string | null;
    lastProblem: { code: number | null; reason: string; at: string } | null;
    groups: { id: string; name: string }[];
    target: { jid: string; name: string; enabled: boolean } | null;
    outbox: { pending: number; lastSentAt: string | null; lastError: string | null };
  }

  let st = $state<Status | null>(null);
  let phone = $state("");
  let busy = $state(false);
  let confirmUnlink = $state(false);
  let failed = $state(false);

  async function load() {
    try {
      st = await api<Status>("/api/whatsapp");
      failed = false;
    } catch {
      failed = true;
    }
  }

  // refresh quickly while something is about to change, slowly otherwise
  $effect(() => {
    void app.state?.whatsapp; // a group change by anyone refreshes the card
    void load();
  });
  $effect(() => {
    const fast = !st || st.bridge !== "up" || st.state === "pairing" || st.state === "starting";
    const t = setInterval(load, fast ? 3000 : 15000);
    return () => clearInterval(t);
  });

  async function act(path: string, body?: unknown, done?: string) {
    busy = true;
    try {
      const r = await api<Status | { code?: string }>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      if (r && "bridge" in r) st = r;
      else await load();
      if (done) toast(done);
    } catch (e) {
      toast("WhatsApp", (e as Error).message, "error");
    } finally {
      busy = false;
      confirmUnlink = false;
    }
  }

  const code = $derived(st?.code ? `${st.code.slice(0, 4)}-${st.code.slice(4)}` : "");
  const active = $derived(!!st?.target?.enabled && st.state === "linked");
  const time = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: app.state?.config.timezone });
</script>

<section class="card wa" data-testid="whatsapp-card" data-state={st ? (active ? "active" : (st.state ?? st.bridge)) : "loading"}>
  <span class="lbl">WhatsApp group</span>

  {#if !st}
    <p class="note">{failed ? "Couldn't load the WhatsApp status." : "Loading…"}</p>
  {:else if st.bridge === "unreachable"}
    <p class="note">The WhatsApp bridge isn't running, so nothing can be posted right now.</p>
  {:else if st.bridge === "starting" || st.state === "starting"}
    <p class="note">The WhatsApp bridge is starting…</p>
  {:else if st.state === "unlinked"}
    <p>Post the rota to the flat's WhatsApp group: every take-out, away weeks and swaps, the Sunday reminder and Monday's new week.</p>
    <p class="note">Posts are sent from one person's WhatsApp, linked like WhatsApp Web. Use the number of whoever is setting this up.</p>
    {#if st.error}<div class="banner" data-testid="wa-error">{st.error}</div>{/if}
    <label class="lbl" for="wa-phone">Your WhatsApp number</label>
    <div class="row">
      <input id="wa-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+49 170 1234567" bind:value={phone} />
      <button class="btn pri" disabled={busy || phone.replace(/\D/g, "").length < 8} onclick={() => act("/api/whatsapp/link", { phone })}>
        Get link code
      </button>
    </div>
  {:else if st.state === "pairing"}
    <p>On the phone with that number, open WhatsApp and enter this code:</p>
    <div class="code" data-testid="wa-code">{code}</div>
    <ol>
      <li>Open <b>Linked devices</b> (Android: ⋮ menu · iPhone: Settings), then <b>Link a device</b></li>
      <li>Tap <b>Link with phone number instead</b></li>
      <li>Type the code above</li>
    </ol>
    <p class="note">Waiting for your phone… The code works for 3 minutes. This card updates by itself.</p>
    <div class="row">
      {#if !phone}
        <input id="wa-phone-again" type="tel" inputmode="tel" aria-label="Your WhatsApp number" placeholder="+49 170 1234567" bind:value={phone} />
      {/if}
      <button class="btn ghost" disabled={busy || phone.replace(/\D/g, "").length < 8} onclick={() => act("/api/whatsapp/link", { phone })}>
        Get a new code
      </button>
    </div>
  {:else}
    <div class="row between">
      <span>Linked as <b>{st.me}</b></span>
      {#if confirmUnlink}
        <span class="row">
          <button class="btn sm" disabled={busy} onclick={() => act("/api/whatsapp/unlink", undefined, "Unlinked")}>Unlink</button>
          <button class="btn sm ghost" onclick={() => (confirmUnlink = false)}>Keep</button>
        </span>
      {:else}
        <button class="btn sm ghost" onclick={() => (confirmUnlink = true)}>Unlink…</button>
      {/if}
    </div>
    {#if confirmUnlink}<p class="note">Unlinking stops all posts until a number is linked again.</p>{/if}

    {#if active && st.target}
      <div class="target" data-testid="wa-target">
        <span>Posting to <b>{st.target.name}</b></span>
        <span class="note">
          {st.outbox.lastSentAt ? `Last post ${time(st.outbox.lastSentAt)}` : "Nothing posted yet"}{st.outbox.pending
            ? ` · ${st.outbox.pending} waiting`
            : ""}
        </span>
      </div>
      {#if st.outbox.lastError && st.outbox.pending}<div class="banner">Posting is failing: {st.outbox.lastError}. It retries by itself.</div>{/if}
      <div class="row">
        <button class="btn" disabled={busy} onclick={() => act("/api/whatsapp/test", undefined, "Test message queued")}>Send test message</button>
        <button class="btn ghost" disabled={busy} onclick={() => act("/api/whatsapp/off", undefined, "WhatsApp posts are off")}>Turn off</button>
      </div>
    {:else}
      {#if st.target && !st.target.enabled}<p class="note">Posting is off. Pick a group to turn it back on.</p>{/if}
      <span class="lbl">Post to which group?</span>
      {#if !st.groups.length}
        <p class="note">This number isn't in any groups yet.</p>
      {/if}
      <div class="groups">
        {#each st.groups as g (g.id)}
          <button class="btn group" disabled={busy} onclick={() => act("/api/whatsapp/group", { jid: g.id }, `Posting to ${g.name}`)}>{g.name}</button>
        {/each}
      </div>
    {/if}
  {/if}
  {#if st?.lastProblem && st.state !== "linked"}
    <p class="note problem" data-testid="wa-problem">Last connection problem: {st.lastProblem.reason}</p>
  {/if}
</section>

<style>
  .wa { gap: 10px; }
  .between { justify-content: space-between; }
  input {
    font: inherit;
    flex: 1;
    min-width: 0;
    border: 1.5px solid var(--ink);
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--paper);
    color: var(--ink);
  }
  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-align: center;
    padding: 10px;
    border: 1.5px dashed var(--ink);
    border-radius: 12px;
    background: var(--paper-2);
  }
  ol { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 3px; font-size: 0.9rem; }
  .target { display: flex; flex-direction: column; gap: 2px; }
  .groups { display: flex; flex-direction: column; gap: 6px; }
  .group { text-align: left; }
  .problem { font-size: 0.75rem; }
</style>
