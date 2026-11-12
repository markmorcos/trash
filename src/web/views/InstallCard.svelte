<script lang="ts">
  import { toast } from "../lib/app.svelte";
  import { dismissHint, guide, install, promptInstall } from "../lib/install.svelte";

  let { compact = false }: { compact?: boolean } = $props();
  const g = $derived(guide());

  async function onInstall() {
    const r = await promptInstall();
    if (r === "accepted") toast("Installed", "Open Trash from your home screen or app list.");
  }
</script>

<section class="card install" class:compact data-testid="install-card" data-platform={install.platform}>
  <div class="head">
    <img src="/icon-192.png" alt="" width="40" height="40" />
    <div class="t">
      <span class="lbl">{compact ? "Tip" : "On this device"}</span>
      <h2>{g.title}</h2>
    </div>
    {#if compact}
      <button class="btn sm ghost" onclick={dismissHint}>Got it</button>
    {/if}
  </div>
  {#if g.button}
    <button class="btn pri" onclick={onInstall}>Install Trash</button>
  {/if}
  {#if g.steps.length}
    <ol>
      {#each g.steps as step, i (i)}<li>{step}</li>{/each}
    </ol>
  {/if}
  {#if g.note}<p class="note">{g.note}</p>{/if}
</section>

<style>
  .install { gap: 10px; }
  .head { display: flex; align-items: center; gap: 10px; }
  .head img { border-radius: 10px; flex: none; }
  .t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  h2 { font-size: 1.35rem; }
  ol { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 4px; font-size: 0.9rem; }
  .compact { border-style: dashed; }
  .btn.pri { align-self: flex-start; }
</style>
