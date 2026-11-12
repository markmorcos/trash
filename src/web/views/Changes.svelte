<script lang="ts">
  import { BIN_LABELS, addWeeks, assignWeek, binsOf, validateOverride, type Override } from "../../shared/rotation";
  import { app, nameOf, person, send, thisWeek } from "../lib/app.svelte";
  import { day, list } from "../lib/format";

  const st = $derived(app.state!);
  const weeks = $derived(Array.from({ length: 8 }, (_, i) => addWeeks(thisWeek(), i)));
  let draft = $state<null | { kind: "away" } | { kind: "swap"; with: string | null }>(null);

  $effect(() => {
    if (!app.selectedWeek || app.selectedWeek < thisWeek()) app.selectedWeek = thisWeek();
  });

  const week = $derived(app.selectedWeek ?? thisWeek());
  const a = $derived(assignWeek(st.config, st.overrides, week));
  const me = $derived(app.me!);
  const myLabel = (asg: typeof a, p: string) => {
    if (asg.away.includes(p)) return "away";
    const b = binsOf(asg, p);
    return b.length ? list(b.map((x) => BIN_LABELS[x])) : "on break";
  };

  /** What the week would look like with this change. */
  const preview = $derived.by(() => {
    if (!draft) return null;
    const other = draft.kind === "swap" ? draft.with : null;
    if (draft.kind === "swap" && !other) return null;
    const err = validateOverride(st.config, st.overrides, week, draft.kind, me, other);
    const fake: Override = { id: "preview", week, kind: draft.kind, person: me, other, createdBy: me };
    const after = assignWeek(st.config, [...st.overrides, fake], week);
    return { err, after };
  });

  const candidates = $derived(
    st.config.people.filter((p) => p.id !== me && !a.away.includes(p.id)),
  );
  const active = $derived(st.overrides.filter((o) => o.week >= thisWeek()));

  function pickWeek(w: string) {
    app.selectedWeek = w;
    draft = null;
  }

  function confirm() {
    if (!draft) return;
    const ok = send({
      type: "override",
      week,
      kind: draft.kind,
      ...(draft.kind === "swap" && draft.with ? { with: draft.with } : {}),
    });
    if (ok) draft = null;
  }

  const ERR: Record<string, string> = {
    already_away: "You're already away that week.",
    partner_away: "They're away that week.",
    already_swapped: "One of you already has a swap that week.",
    not_on_rota: "You're not on the rota that week.",
    same_person: "Pick someone else.",
    unknown_person: "Unknown person.",
  };
</script>

<header>
  <h1 class="title">Changes</h1>
  <p class="sub">Swaps and away weeks change one week only. The rotation carries on after.</p>
</header>

<div class="row weeks" role="group" aria-label="Week">
  {#each weeks as w, i (w)}
    <button class="chip" aria-pressed={w === week} onclick={() => pickWeek(w)}>{i === 0 ? "This week" : day(w)}</button>
  {/each}
</div>

<section class="card">
  <span class="lbl">Week of {day(week)} · you: {myLabel(a, me)}</span>

  {#if !draft}
    <div class="row">
      <button class="btn" disabled={a.away.includes(me)} onclick={() => (draft = { kind: "away" })}>I'm away</button>
      <button class="btn" disabled={a.away.includes(me)} onclick={() => (draft = { kind: "swap", with: null })}>Swap with…</button>
    </div>
  {:else if draft.kind === "swap"}
    <span class="lbl">Swap with</span>
    <div class="row">
      {#each candidates as p (p.id)}
        <button class="chip" aria-pressed={draft.with === p.id} onclick={() => draft?.kind === "swap" && (draft.with = p.id)}>
          {p.emoji} {p.name} <span class="note">({myLabel(a, p.id)})</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if draft && preview}
    <div class="preview">
      {#if preview.err}
        <div>{ERR[preview.err]}</div>
      {:else if draft.kind === "away"}
        {@const covers = preview.after.bins.filter((b) => b.covering === me)}
        {#if covers.length === 0}
          <div>You're on break anyway. You'll show as away.</div>
        {:else}
          {#each covers as b (b.bin)}
            <div>
              {BIN_LABELS[b.bin]} → <b>{b.person ? nameOf(b.person) : "nobody (unassigned)"}</b>{b.person &&
              binsOf(preview.after, b.person).length > 1
                ? `, who then has ${binsOf(preview.after, b.person).length} bins`
                : ""}
            </div>
          {/each}
          <div class="note">They get a notification.</div>
        {/if}
      {:else if draft.kind === "swap" && draft.with}
        <div>After: you → <b>{myLabel(preview.after, me)}</b>, {nameOf(draft.with)} → <b>{myLabel(preview.after, draft.with)}</b>.</div>
        <div class="note">{nameOf(draft.with)} gets a notification.</div>
      {/if}
    </div>
  {/if}

  {#if draft}
    <div class="row">
      <button class="btn pri" disabled={!preview || !!preview.err} onclick={confirm}>
        {draft.kind === "away" ? "Confirm away" : "Confirm swap"}
      </button>
      <button class="btn ghost" onclick={() => (draft = null)}>Cancel</button>
    </div>
  {/if}
</section>

<section class="card">
  <span class="lbl">Coming up</span>
  {#if !active.length}
    <p class="note">No swaps or away weeks planned.</p>
  {/if}
  {#each active as o (o.id)}
    <div class="item">
      <span>
        {day(o.week)} ·
        {#if o.kind === "away"}{person(o.person)?.emoji} {nameOf(o.person)} away
        {:else}{nameOf(o.person)} ⇄ {nameOf(o.other)}{/if}
      </span>
      <button class="btn sm ghost" onclick={() => send({ type: "undoOverride", id: o.id })}>Undo</button>
    </div>
  {/each}
</section>

<style>
  .weeks { gap: 6px; }
  .chip {
    font-size: 0.82rem;
    border-radius: 8px;
    padding: 5px 10px;
    border: 1.5px solid var(--line);
    background: var(--paper);
    cursor: pointer;
  }
  .chip[aria-pressed="true"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .chip[aria-pressed="true"] .note { color: var(--paper); }
  .preview { background: var(--paper-2); border-radius: 10px; padding: 9px 11px; font-size: 0.88rem; display: flex; flex-direction: column; gap: 3px; }
  .item { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 0.88rem; padding: 4px 0; border-bottom: 1px dashed var(--line); }
  .item:last-child { border-bottom: 0; }
</style>
