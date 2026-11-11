<script lang="ts">
  import { app, choose } from "../lib/app.svelte";

  let error = $state("");
  let busy = $state(false);

  async function pick(id: string) {
    busy = true;
    error = "";
    try {
      await choose(id);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="join">
  <h1 class="title">Who are you?</h1>
  <p class="sub">Pick your magnet. This phone remembers it, and you can change it later in Settings.</p>
  {#if app.people.length}
    <div class="tiles">
      {#each app.people as p (p.id)}
        <button class="tile" disabled={busy} onclick={() => pick(p.id)}>
          <span class="m" aria-hidden="true">{p.emoji}</span>
          <b>{p.name}</b>
          <span class="note">{p.magnet}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="banner">Can't reach the server. Check your connection and reload.</div>
  {/if}
  {#if error}<div class="banner">{error}</div>{/if}
</div>

<style>
  .join { display: flex; flex-direction: column; gap: 12px; margin-top: 8vh; }
  .title { font-size: 2.6rem; }
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
