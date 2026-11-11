<script lang="ts">
  import { app, choose, login } from "../lib/app.svelte";

  let passcode = $state("");
  let error = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!passcode.trim()) return;
    busy = true;
    error = "";
    try {
      await login(passcode);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function pick(id: string) {
    busy = true;
    try {
      await choose(id);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

{#if app.status === "passcode"}
  <form class="join" onsubmit={submit}>
    <h1 class="title">Trash</h1>
    <p class="sub">Who takes which bin this week. Enter the house passcode to join.</p>
    {#if !app.passcodeSet}
      <div class="banner">The passcode isn't set up on the server yet. Run the bootstrap workflow first.</div>
    {/if}
    <label class="lbl" for="passcode">House passcode</label>
    <input id="passcode" type="password" autocomplete="current-password" bind:value={passcode} />
    {#if error}<div class="banner">{error}</div>{/if}
    <button class="btn pri" type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
  </form>
{:else}
  <div class="join">
    <h1 class="title">Who are you?</h1>
    <p class="sub">Pick your magnet. You can change it later in Settings.</p>
    <div class="tiles">
      {#each app.people as p (p.id)}
        <button class="tile" disabled={busy} onclick={() => pick(p.id)}>
          <span class="m" aria-hidden="true">{p.emoji}</span>
          <b>{p.name}</b>
          <span class="note">{p.magnet}</span>
        </button>
      {/each}
    </div>
    {#if error}<div class="banner">{error}</div>{/if}
  </div>
{/if}

<style>
  .join { display: flex; flex-direction: column; gap: 12px; margin-top: 8vh; }
  .title { font-size: 2.6rem; }
  input {
    font: inherit;
    font-size: 1.05rem;
    border: 1.5px solid var(--ink);
    border-radius: 10px;
    padding: 10px 12px;
    background: var(--paper);
    color: var(--ink);
  }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
  .tile {
    border: 1.5px solid var(--ink);
    border-radius: 14px;
    background: var(--paper);
    padding: 14px 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    cursor: pointer;
  }
  .tile .m { font-size: 2.2rem; }
</style>
