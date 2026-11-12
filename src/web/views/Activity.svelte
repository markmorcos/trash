<script lang="ts">
  import { describe, type HouseEvent } from "../../shared/events";
  import { localDate } from "../../shared/rotation";
  import { app, person, today, tz } from "../lib/app.svelte";
  import { DOW, day } from "../lib/format";
  import { weekday, addDays } from "../../shared/rotation";

  const st = $derived(app.state!);
  const byId = $derived(new Map(st.activity.map((e) => [e.id, e])));
  // the server also sends events that recent undos refer to; show only the latest 100
  const shown = $derived(st.activity.slice(0, 100));

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz() });
  function dayLabel(date: string) {
    if (date === today()) return "Today";
    if (date === addDays(today(), -1)) return "Yesterday";
    return `${DOW[weekday(date)]} ${day(date)}`;
  }
  const groups = $derived.by(() => {
    const out: { date: string; items: HouseEvent[] }[] = [];
    for (const e of shown) {
      const d = localDate(new Date(e.at), tz());
      if (out.at(-1)?.date !== d) out.push({ date: d, items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  });
  const undo = (e: HouseEvent) => e.data.type === "change.undone" || e.data.type === "bin.take_out_undone";
</script>

<header>
  <h1 class="title">Activity</h1>
  <p class="sub">Everything anyone changed, newest first. Nothing here can be edited or deleted.</p>
</header>

{#if !groups.length}
  <p class="note">Nothing has happened yet.</p>
{/if}

{#each groups as g (g.date)}
  <section class="card" data-testid="day-{g.date}">
    <span class="lbl">{dayLabel(g.date)}</span>
    {#each g.items as e (e.id)}
      <div class="ev" class:undo={undo(e)} data-testid="event-{e.data.type}">
        <span class="t">{time(e.at)}</span>
        <span class="m" aria-hidden="true">{e.actor ? (person(e.actor)?.emoji ?? "·") : "⚙"}</span>
        <span class="txt">{describe(e, st.config, byId)}</span>
        <span class="n" title="Event number">#{e.id}</span>
      </div>
    {/each}
  </section>
{/each}

<style>
  header { display: flex; flex-direction: column; gap: 2px; }
  .ev {
    display: grid;
    grid-template-columns: 44px 22px minmax(0, 1fr) auto;
    gap: 6px;
    align-items: baseline;
    font-size: 0.88rem;
    padding: 5px 0;
    border-bottom: 1px dashed var(--line);
  }
  .ev:last-child { border-bottom: 0; }
  .t, .n { font-size: 0.75rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .txt { min-width: 0; overflow-wrap: anywhere; }
  .undo .txt { color: var(--ink-2); font-style: italic; }
</style>
