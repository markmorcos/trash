<script lang="ts">
  import { BIN_LABELS, addWeeks, assignWeek, isoWeekNumber } from "../../shared/rotation";
  import { app, go, nameOf, thisWeek } from "../lib/app.svelte";
  import { BIN_COLORS, range } from "../lib/format";

  const st = $derived(app.state!);
  const weeks = $derived(Array.from({ length: 8 }, (_, i) => addWeeks(thisWeek(), i)));
  const history = $derived(
    [...new Set(st.history.map((h) => h.week))].slice(0, 4).map((w) => ({
      week: w,
      rows: st.history.filter((h) => h.week === w),
    })),
  );

  function open(week: string) {
    app.selectedWeek = week;
    go("changes");
  }
</script>

<header>
  <h1 class="title">Upcoming</h1>
  <p class="sub">Tap a week to swap or mark yourself away.</p>
</header>

{#each weeks as w, i (w)}
  {@const a = assignWeek(st.config, st.overrides, w)}
  {@const ov = st.overrides.filter((o) => o.week === w)}
  <button class="wk" class:now={i === 0} onclick={() => open(w)}>
    <span class="wk-top">
      <span>{i === 0 ? "This week" : `Week ${isoWeekNumber(w)}`} · {range(w)}</span>
      <span class="row">
        {#each ov as o (o.id)}<span class="pill mute">{o.kind === "away" ? `${nameOf(o.person)} away` : "Swap"}</span>{/each}
      </span>
    </span>
    <span class="chips">
      {#each a.bins as b (b.bin)}
        <span class="chip" class:me={b.person === app.me} title={BIN_LABELS[b.bin]}>
          <i style:background={BIN_COLORS[b.bin]}></i>{b.person ? nameOf(b.person) : "—"}
        </span>
      {/each}
      {#each a.resting as r (r)}
        <span class="chip rest" class:me={r === app.me}><i style:background="var(--break)"></i>{nameOf(r)} rests</span>
      {/each}
    </span>
  </button>
{/each}

{#if history.length}
  <section class="card">
    <span class="lbl">Past weeks</span>
    {#each history as h (h.week)}
      <div class="hist">
        <span>{range(h.week)}</span>
        <span class="row">
          {#each h.rows as r (r.bin)}
            <span class="pill {r.status === 'done' ? 'ok' : 'warn'}">{BIN_LABELS[r.bin]} {r.status === "done" ? (r.count > 1 ? `✓ ×${r.count}` : "✓") : "missed"}</span>
          {/each}
        </span>
      </div>
    {/each}
  </section>
{/if}

<style>
  .wk {
    display: flex;
    flex-direction: column;
    gap: 7px;
    border: 1.5px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    background: var(--paper);
    cursor: pointer;
    text-align: left;
    width: 100%;
  }
  .wk.now { border-color: var(--ink); }
  .wk-top { display: flex; justify-content: space-between; gap: 8px; font-size: 0.85rem; font-weight: 700; flex-wrap: wrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip {
    font-size: 0.78rem;
    border-radius: 6px;
    padding: 1px 7px;
    border: 1px solid var(--line);
    display: inline-flex;
    gap: 5px;
    align-items: center;
  }
  .chip i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .chip.me { border-color: var(--accent); color: var(--accent); font-weight: 700; }
  .chip.rest { border-style: dashed; }
  .hist { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; padding-bottom: 6px; border-bottom: 1px dashed var(--line); }
  .hist:last-child { border-bottom: 0; }
</style>
