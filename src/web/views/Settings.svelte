<script lang="ts">
  import { BIN_LABELS, BINS, baseLineup } from "../../shared/rotation";
  import { app, nameOf, person, send, switchPerson, thisWeek, toast } from "../lib/app.svelte";
  import { isSubscribed, pushSupport, subscribe, unsubscribe } from "../lib/push";

  const st = $derived(app.state!);
  const support = pushSupport();
  let subscribed = $state(false);
  let busy = $state(false);

  $effect(() => {
    if (support === "ok") isSubscribed().then((v) => (subscribed = v)).catch(() => {});
  });

  async function toggle() {
    busy = true;
    try {
      if (subscribed) {
        await unsubscribe();
        subscribed = false;
        toast("Reminders off", "This device won't get notifications.");
      } else {
        await subscribe();
        subscribed = true;
        toast("Reminders on", "You'll get the Sunday reminder and swap/cover alerts here.");
      }
    } catch (e) {
      toast("Couldn't change reminders", (e as Error).message, "error");
    } finally {
      busy = false;
    }
  }

  // this week's base lineup (before swaps/away), editable
  let lineup = $state<string[] | null>(null);
  const shown = $derived(lineup ?? baseLineup(st.config, thisWeek()));
  function move(i: number, d: -1 | 1) {
    const l = [...shown];
    [l[i], l[i + d]] = [l[i + d], l[i]];
    lineup = l;
  }
  function applyLineup() {
    if (lineup && send({ type: "updateConfig", baseRev: st.config.rev, lineup })) lineup = null;
  }

  let names = $state<Record<string, string> | null>(null);
  function startRename() {
    names = Object.fromEntries(st.config.people.map((p) => [p.id, p.name]));
  }
  function saveNames() {
    if (names && send({ type: "updateConfig", baseRev: st.config.rev, names })) names = null;
  }

  // a config change from someone else invalidates local drafts
  let seenRev = -1;
  $effect(() => {
    const rev = st.config.rev;
    if (seenRev !== -1 && rev !== seenRev) {
      lineup = null;
      names = null;
    }
    seenRev = rev;
  });
</script>

<header>
  <h1 class="title">Settings</h1>
  <p class="sub">Shared by everyone in the house.</p>
</header>

<section class="card">
  <span class="lbl">Me</span>
  <div class="row between">
    <span>{person(app.me)?.emoji} {nameOf(app.me)}</span>
    <button class="btn sm ghost" onclick={switchPerson}>I'm not {nameOf(app.me)}</button>
  </div>
  {#if !app.pushEnabled}
    <p class="note">Reminders aren't set up on the server yet.</p>
  {:else if support === "ios-install"}
    <div class="banner calm">
      To get reminders on iPhone, open this page in Safari, tap <b>Share → Add to Home Screen</b>, then open Trash from your
      home screen and come back here.
    </div>
  {:else if support === "unsupported"}
    <p class="note">This browser can't show notifications. Try Chrome, Firefox or Safari.</p>
  {:else if support === "denied"}
    <p class="note">Notifications are blocked for this site. Allow them in the browser's site settings.</p>
  {:else}
    <div class="row between">
      <span>Sunday reminder and swap alerts<br /><span class="note">on this device</span></span>
      <button class="sw" role="switch" aria-checked={subscribed} aria-label="Reminders" disabled={busy} onclick={toggle}></button>
    </div>
  {/if}
</section>

<section class="card">
  <span class="lbl">This week's rotation</span>
  <p class="note">Everyone moves one bin to the right each Monday. Reorder to fix the rotation from this week on.</p>
  {#each shown as id, i (id)}
    <div class="item">
      <span><span class="slot">{i < BINS.length ? BIN_LABELS[BINS[i]] : "On break"}</span> {person(id)?.emoji} {nameOf(id)}</span>
      <span class="row">
        <button class="btn sm ghost" aria-label="Move {nameOf(id)} up" disabled={i === 0} onclick={() => move(i, -1)}>↑</button>
        <button class="btn sm ghost" aria-label="Move {nameOf(id)} down" disabled={i === shown.length - 1} onclick={() => move(i, 1)}>↓</button>
      </span>
    </div>
  {/each}
  {#if lineup}
    <div class="banner">This changes the rotation for everyone, from this week on.</div>
    <div class="row">
      <button class="btn pri" onclick={applyLineup}>Apply for everyone</button>
      <button class="btn ghost" onclick={() => (lineup = null)}>Cancel</button>
    </div>
  {/if}
</section>

<section class="card">
  <span class="lbl">Names</span>
  {#if names}
    {#each st.config.people as p (p.id)}
      <label class="item">
        <span>{p.emoji}</span>
        <input id="name-{p.id}" bind:value={names[p.id]} maxlength="30" />
      </label>
    {/each}
    <div class="row">
      <button class="btn pri" onclick={saveNames}>Save names</button>
      <button class="btn ghost" onclick={() => (names = null)}>Cancel</button>
    </div>
  {:else}
    <p class="note">{st.config.people.map((p) => `${p.emoji} ${p.name}`).join(" · ")}</p>
    <div><button class="btn sm ghost" onclick={startRename}>Rename someone</button></div>
  {/if}
</section>

<p class="note center">
  {app.online ? `Live · v${st.version}` : `Offline · v${st.version}`} · {app.presence.length} online · {st.config.timezone}
</p>

<style>
  .between { justify-content: space-between; }
  .item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px dashed var(--line); }
  .item:last-of-type { border-bottom: 0; }
  .slot { display: inline-block; min-width: 84px; font-size: 0.75rem; color: var(--ink-2); font-weight: 700; }
  input {
    font: inherit;
    flex: 1;
    min-width: 0;
    border: 1.5px solid var(--ink);
    border-radius: 8px;
    padding: 6px 9px;
    background: var(--paper);
    color: var(--ink);
  }
  .center { text-align: center; }
  .sw {
    width: 46px;
    height: 26px;
    flex: none;
    border-radius: 999px;
    border: 1.5px solid var(--ink);
    background: var(--paper-2);
    position: relative;
    cursor: pointer;
    padding: 0;
  }
  .sw::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: var(--ink);
    transition: left 0.15s;
  }
  .sw[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
  .sw[aria-checked="true"]::after { left: 22px; background: var(--accent-ink); }
</style>
