<script lang="ts">
  import { app, go, type Tab } from "./lib/app.svelte";
  import Join from "./views/Join.svelte";
  import Week from "./views/Week.svelte";
  import Upcoming from "./views/Upcoming.svelte";
  import Changes from "./views/Changes.svelte";
  import Settings from "./views/Settings.svelte";
  import Activity from "./views/Activity.svelte";

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "week", label: "This week", icon: "▦" },
    { id: "upcoming", label: "Upcoming", icon: "≡" },
    { id: "changes", label: "Changes", icon: "⇄" },
    { id: "activity", label: "Activity", icon: "☰" },
    { id: "settings", label: "Settings", icon: "⚙" },
  ];
</script>

{#if app.toast}
  <div class="toast" class:error={app.toast.kind === "error"} role="status">
    <b>{app.toast.title}</b>
    {#if app.toast.body}<span>{app.toast.body}</span>{/if}
  </div>
{/if}

{#if app.status === "loading"}
  <main class="center"><p class="sub">Loading…</p></main>
{:else if app.status === "who"}
  <main><Join /></main>
{:else if app.state}
  {#if !app.online}
    <div class="offline">Offline · showing v{app.state.version} · reconnecting</div>
  {/if}
  <main>
    {#if app.tab === "week"}<Week />
    {:else if app.tab === "upcoming"}<Upcoming />
    {:else if app.tab === "changes"}<Changes />
    {:else if app.tab === "activity"}<Activity />
    {:else}<Settings />{/if}
  </main>
  <nav class="tabs" aria-label="Sections">
    {#each tabs as t (t.id)}
      <button aria-current={app.tab === t.id ? "page" : undefined} onclick={() => go(t.id)}>
        <span class="ti" aria-hidden="true">{t.icon}</span>{t.label}
      </button>
    {/each}
  </nav>
{:else}
  <main class="center"><p class="sub">Connecting…</p></main>
{/if}

<style>
  main {
    max-width: 560px;
    margin: 0 auto;
    padding: calc(env(safe-area-inset-top, 0px) + 18px) max(16px, env(safe-area-inset-right, 0px))
      calc(env(safe-area-inset-bottom, 0px) + 96px) max(16px, env(safe-area-inset-left, 0px));
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .center { min-height: 60vh; align-items: center; justify-content: center; }
  .tabs {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    background: var(--paper);
    border-top: 1.5px dashed var(--line);
    padding: 0 env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    z-index: 5;
  }
  .tabs button {
    background: none;
    border: 0;
    padding: 9px 2px 11px;
    font-size: 0.75rem;
    color: var(--ink-2);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .tabs .ti { font-family: var(--font-hand); font-size: 1.2rem; line-height: 1; }
  .tabs button[aria-current="page"] { color: var(--accent); font-weight: 700; }
  .offline {
    position: sticky;
    top: 0;
    z-index: 6;
    background: var(--warn-bg);
    color: var(--warn);
    text-align: center;
    font-size: 0.8rem;
    font-weight: 600;
    padding: calc(env(safe-area-inset-top, 0px) + 6px) 12px 6px;
  }
  .toast {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    left: 50%;
    transform: translateX(-50%);
    width: min(520px, calc(100% - 32px));
    background: var(--ink);
    color: var(--paper);
    border-radius: 14px;
    padding: 10px 14px;
    box-shadow: var(--shadow);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.88rem;
    animation: drop 0.2s ease-out;
  }
  .toast.error b { color: var(--warn-bg); }
  @keyframes drop {
    from { transform: translate(-50%, -8px); opacity: 0.4; }
    to { transform: translate(-50%, 0); opacity: 1; }
  }
</style>
