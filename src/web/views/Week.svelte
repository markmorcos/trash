<script lang="ts">
  import { BIN_LABELS, assignWeek, addWeeks, isoWeekNumber, nextRestWeek, weekday } from "../../shared/rotation";
  import { app, nameOf, person, send, thisWeek, today } from "../lib/app.svelte";
  import { BIN_COLORS, DOW, day, list, range } from "../lib/format";

  const st = $derived(app.state!);
  const week = $derived(thisWeek());
  const a = $derived(assignWeek(st.config, st.overrides, week));
  const done = $derived(new Map(st.checkoffs.filter((c) => c.week === week).map((c) => [c.bin, c])));
  const dow = $derived(weekday(today()));
  const sunday = $derived(dow === 6);
  const outCount = $derived(a.bins.filter((b) => done.has(b.bin)).length);
  const myBins = $derived(a.bins.filter((b) => b.person === app.me).map((b) => BIN_LABELS[b.bin]));
  const nextRest = $derived(app.me ? nextRestWeek(st.config, st.overrides, addWeeks(week, a.resting.includes(app.me) ? 1 : 0), app.me) : null);
  const iAmAway = $derived(app.me ? a.away.includes(app.me) : false);
</script>

<header>
  <h1 class="title">Week {isoWeekNumber(week)}</h1>
  <p class="sub">
    {range(week)} · {sunday ? "last day" : `${6 - dow} day${6 - dow === 1 ? "" : "s"} left`} · {outCount}/4 out
  </p>
</header>

{#if sunday && outCount < 4}
  <div class="banner">Sunday: every bin goes out today. {4 - outCount} still pending.</div>
{:else if sunday}
  <div class="banner calm">All four bins are out. See you Monday.</div>
{/if}

<div class="bins">
  {#each a.bins as b (b.bin)}
    {@const p = person(b.person)}
    {@const c = done.get(b.bin)}
    {@const mine = b.person === app.me}
    <article class="bin" class:me={mine}>
      <h2 class="bin-h" class:dark-ink={b.bin === "wert"} style:background={BIN_COLORS[b.bin]}>{BIN_LABELS[b.bin]}</h2>
      <div class="bin-b">
        <div class="who">
          <span class="m" aria-hidden="true">{p?.emoji ?? "?"}</span>
          {p?.name ?? "Nobody"}
          {#if b.person && app.presence.includes(b.person)}<span class="live" title="Online now"></span>{/if}
        </div>
        {#if b.covering}<span class="note">covering for {nameOf(b.covering)}</span>{/if}
        {#if !b.person}
          <span class="pill warn">Unassigned</span>
        {:else if c}
          <span class="pill ok">Out ✓ {DOW[weekday(c.doneAt.slice(0, 10))]}</span>
        {:else if sunday}
          <span class="pill warn">Due today</span>
        {:else}
          <span class="pill pend">Pending</span>
        {/if}
        {#if mine}
          {#if c}
            <button class="btn sm ghost" onclick={() => send({ type: "uncheckoff", week, bin: b.bin })}>Undo</button>
          {:else}
            <button class="btn sm pri" onclick={() => send({ type: "checkoff", week, bin: b.bin })}>I took it out</button>
          {/if}
        {/if}
      </div>
    </article>
  {/each}

  <article class="bin rest" class:me={app.me != null && a.resting.includes(app.me)}>
    <h2 class="bin-h" style:background="var(--break)">On break</h2>
    <div class="bin-b">
      {#if a.resting.length}
        {#each a.resting as r (r)}
          <div class="who"><span class="m" aria-hidden="true">{person(r)?.emoji}</span>{nameOf(r)}</div>
        {/each}
        <span class="note">Rest week, no bin</span>
      {:else}
        <span class="note">Nobody rests this week</span>
      {/if}
      {#if a.away.length}
        <span class="note">Away: {list(a.away.map(nameOf))}</span>
      {/if}
    </div>
  </article>
</div>

<div class="banner calm">
  {#if iAmAway}
    You're marked away this week.
  {:else if myBins.length}
    You have <b>{list(myBins)}</b> this week.
  {:else}
    You're on break this week.
  {/if}
  {#if nextRest}Next break: week of {day(nextRest)}.{/if}
</div>

<style>
  header { display: flex; flex-direction: column; gap: 2px; }
  .bins { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .bin {
    border: 1.5px solid var(--ink);
    border-radius: 10px;
    background: var(--paper);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    box-shadow: var(--shadow);
  }
  .bin.me { outline: 3px solid var(--accent); outline-offset: 1px; }
  .bin-h { font-size: 1.2rem; padding: 4px 10px; color: #fff; }
  .bin-h.dark-ink { color: #1d1a0c; }
  .bin-b { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; flex: 1; }
  .who { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  .who .m { font-size: 1.4rem; }
  .live { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
  .rest { grid-column: 1 / -1; border-style: dashed; flex-direction: row; box-shadow: none; }
  .rest .bin-h { display: flex; align-items: center; min-width: 110px; }
  @media (max-width: 360px) { .bins { grid-template-columns: 1fr; } }
</style>
