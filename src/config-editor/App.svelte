<script lang="ts">
  import { onMount } from "svelte";
  import { css, cx } from "styled-system/css";
  import type { ConfigIssue } from "../lib/ui-config.js";
  import type { ConfigSnapshot } from "../cli/lib/config-editor/handler.js";
  import FieldRow from "./FieldRow.svelte";
  import { loadConfig, saveConfig } from "./api.js";
  import {
    type Changes,
    currentValue,
    hasChange,
    matchesFilter,
    usesDefault,
    withChange,
  } from "./edit-state.js";

  let { token }: { token: string | null } = $props();

  let snapshot = $state<ConfigSnapshot | null>(null);
  let changes = $state<Changes>({});
  /** Issues from a refused save, which describe the edited config rather than the file. */
  let saveIssues = $state<ConfigIssue[] | null>(null);
  /** Bumped on every load so the rows rebuild their controls from the new values. */
  let revision = $state(0);
  let filter = $state("");
  let status = $state<{ message: string; kind: "" | "ok" | "error" }>({ message: "", kind: "" });
  let saving = $state(false);

  const dirty = $derived(Object.keys(changes).length > 0);
  const issues = $derived(saveIssues ?? snapshot?.issues ?? []);
  const knownPaths = $derived(new Set(snapshot?.fields.map((field) => field.path) ?? []));
  const groups = $derived(
    snapshot
      ? snapshot.groups
          .map((group) => ({
            group,
            fields: snapshot!.fields.filter(
              (field) => field.group === group && matchesFilter(field, filter),
            ),
          }))
          .filter(({ fields }) => fields.length > 0)
      : [],
  );

  function show(next: ConfigSnapshot) {
    snapshot = next;
    changes = {};
    saveIssues = null;
    revision += 1;
  }

  async function load() {
    if (!token) {
      status = { message: "Open this page with the link printed by kozane config open.", kind: "error" };
      return;
    }
    const result = await loadConfig(token);
    if (!result.ok) {
      status = { message: result.error, kind: "error" };
      return;
    }
    show(result.snapshot);
    status = { message: "", kind: "" };
  }

  async function save() {
    if (!snapshot || !token || !dirty || saving) return;
    saving = true;
    status = { message: "Saving…", kind: "" };
    const result = await saveConfig(token, snapshot.signature, changes);
    saving = false;
    if (result.ok) {
      show(result.snapshot);
      status = { message: "Saved. Reload open boards to see UI changes.", kind: "ok" };
      return;
    }
    if (result.issues) saveIssues = result.issues;
    status = { message: result.error, kind: "error" };
  }

  function change(path: string, value: unknown) {
    const field = snapshot!.fields.find((candidate) => candidate.path === path)!;
    changes = withChange(snapshot!, changes, field, value);
    status = { message: Object.keys(changes).length > 0 ? "Unsaved changes" : "", kind: "" };
  }

  function handleKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      void save();
    }
  }

  function handleBeforeUnload(event: BeforeUnloadEvent) {
    if (dirty) event.preventDefault();
  }

  onMount(() => {
    void load();
  });

  const buttonClass = css({
    padding: "6px 13px",
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "2px",
    background: "ink.white",
    color: "ink.black",
    fontSize: "12.5px",
    fontFamily: "inherit",
    cursor: "pointer",
    _disabled: { opacity: "0.45", cursor: "default" },
  });
  const primaryClass = css({ backgroundColor: "ink.black", borderColor: "ink.black", color: "ink.light" });
  const noticeClass = css({ padding: "10px 12px", borderRadius: "2px", marginBottom: "14px", fontSize: "12.5px" });
  const barClass = css({ maxWidth: "820px", margin: "0 auto", paddingInline: "16px" });
</script>

<svelte:window onkeydown={handleKeydown} onbeforeunload={handleBeforeUnload} />

<div class={css({ minHeight: "100vh", backgroundColor: "ink.lighter", color: "ink.black", fontSize: "12.5px" })}>
  <header
    class={css({
      position: "sticky",
      top: "0",
      zIndex: "2",
      backgroundColor: "ink.light",
      borderBottom: "1px solid token(colors.neutral.dim)",
    })}
  >
    <div class={cx(barClass, css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", paddingBlock: "12px" }))}>
      <div class={css({ flex: "1 1 auto", minWidth: "0" })}>
        <div class={css({ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px" })}>
          <h1 class={css({ fontSize: "14px", fontWeight: "600" })}>Kozane config</h1>
          <!-- Sits on the title line so a message appearing never changes the header height. -->
          <div
            role="status"
            aria-live="polite"
            class={cx(
              css({ fontSize: "12px", color: "neutral.subtle" }),
              status.kind === "ok" && css({ color: "taskspace.text" }),
              status.kind === "error" && css({ color: "state.error" }),
            )}
          >
            {status.message}
          </div>
        </div>
        {#if snapshot}
          <div class={css({ fontFamily: "mono", fontSize: "11px", color: "neutral.muted", wordBreak: "break-all" })}>
            {snapshot.path}
          </div>
        {/if}
      </div>
      <input
        type="search"
        placeholder="Filter settings"
        aria-label="Filter settings"
        bind:value={filter}
        class={css({
          flex: "1 1 180px",
          maxWidth: "240px",
          padding: "6px 9px",
          border: "1px solid token(colors.neutral.dim)",
          borderRadius: "2px",
          fontSize: "12.5px",
          fontFamily: "inherit",
          background: "ink.white",
          color: "ink.black",
        })}
      />
      <button type="button" class={buttonClass} disabled={!dirty || saving} onclick={() => void load()}>
        Discard changes
      </button>
      <button
        type="button"
        class={cx(buttonClass, primaryClass)}
        disabled={!dirty || saving || !snapshot || Boolean(snapshot.readError)}
        onclick={() => void save()}
      >
        Save
      </button>
    </div>
  </header>

  <main class={cx(barClass, css({ paddingBlock: "16px 64px" }))}>
    {#if snapshot?.readError}
      <div class={cx(noticeClass, css({ backgroundColor: "neutral.bg", color: "state.error" }))}>
        <div>{snapshot.readError}</div>
        <div>Edit the config file to fix the error, then reload this page.</div>
      </div>
    {:else}
      {#each ["error", "warning"] as const as severity (severity)}
        {@const list = issues.filter((issue) => issue.severity === severity)}
        {#if list.length > 0}
          <div
            data-notice={severity}
            class={cx(
              noticeClass,
              severity === "error"
                ? css({ backgroundColor: "neutral.bg", color: "state.error" })
                : css({ backgroundColor: "neutral.bg", color: "ink.secondary" }),
            )}
          >
            <div>
              {severity === "error" ? "Fix the config errors before saving." : "Review these warnings. Saving is still available."}
            </div>
            <ul class={css({ margin: "4px 0 0", paddingLeft: "20px" })}>
              {#each list as issue, index (index)}
                <li>{issue.message}{knownPaths.has(issue.path) ? "" : " (not on this page)"}</li>
              {/each}
            </ul>
          </div>
        {/if}
      {/each}
    {/if}

    {#if snapshot}
      {#key revision}
        {#each groups as { group, fields } (group)}
          <section class={css({ marginBottom: "22px" })}>
            <h2
              class={css({
                margin: "0 0 7px",
                fontSize: "11px",
                fontWeight: "600",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "neutral.muted",
              })}
            >
              {group}
            </h2>
            <div
              class={css({
                backgroundColor: "ink.white",
                border: "1px solid token(colors.neutral.border)",
                borderRadius: "2px",
              })}
            >
              {#each fields as field (field.path)}
                <FieldRow
                  {field}
                  value={currentValue(snapshot, changes, field)}
                  changed={hasChange(changes, field)}
                  usingDefault={usesDefault(snapshot, changes, field)}
                  issues={issues.filter((issue) => issue.path === field.path)}
                  disabled={Boolean(snapshot.readError)}
                  onchange={(value) => change(field.path, value)}
                />
              {/each}
            </div>
          </section>
        {/each}
      {/key}
    {/if}
  </main>
</div>
