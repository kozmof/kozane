<script lang="ts">
  import { untrack } from "svelte";
  import { css, cx } from "styled-system/css";
  import type { ConfigIssue } from "../lib/ui-config.js";
  import type { FieldSpec } from "../cli/lib/config-editor/fields.js";
  import {
    MODIFIER_KEYS,
    controlText,
    describeKey,
    describeValue,
    parseListInput,
    numberChange,
  } from "./edit-state.js";

  let {
    field,
    value,
    changed,
    usingDefault,
    issues,
    disabled = false,
    onchange,
  }: {
    field: FieldSpec;
    /** Initial control value, chosen from pending changes, the file, then the default. */
    value: unknown;
    changed: boolean;
    usingDefault: boolean;
    issues: ConfigIssue[];
    disabled?: boolean;
    /** Receives the new value, or `null` to remove the key and use the default. */
    onchange: (value: unknown) => void;
  } = $props();

  const id = $derived(`field-${field.path.replace(/\./g, "-")}`);

  // The controls own their text while it is being edited, so a half-typed number such as
  // "1." is not rewritten under the cursor. The page rebuilds the rows whenever it reloads.
  let text = $state(untrack(() => controlText(field, value)));
  let checked = $state(untrack(() => value === true));
  let choice = $state(untrack(() => (typeof value === "string" ? value : "")));
  let number = $state<number | null>(untrack(() => (typeof value === "number" ? value : null)));

  function useDefault() {
    text = controlText(field, field.defaultValue);
    checked = field.defaultValue === true;
    choice = typeof field.defaultValue === "string" ? field.defaultValue : "";
    number = typeof field.defaultValue === "number" ? field.defaultValue : null;
    onchange(null);
  }

  function recordKey(event: KeyboardEvent) {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (MODIFIER_KEYS.includes(event.key)) return;
    text = describeKey(event.key);
    onchange(event.key);
  }

  function clearKey() {
    text = describeKey("");
    onchange("");
  }

  const inputClass = css({
    width: "100%",
    padding: "6px 9px",
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "2px",
    fontSize: "12.5px",
    fontFamily: "inherit",
    background: "ink.white",
    color: "ink.black",
    _focus: { borderColor: "select.accent" },
    _disabled: { background: "neutral.disabled", cursor: "default" },
  });
  const monoClass = css({ fontFamily: "mono" });
  const smallButtonClass = css({
    padding: "5px 10px",
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "2px",
    background: "ink.white",
    color: "ink.secondary",
    fontSize: "12px",
    fontFamily: "inherit",
    cursor: "pointer",
    _hover: { color: "ink.black" },
    _disabled: { opacity: "0.5", cursor: "default" },
  });
  const linkButtonClass = css({
    padding: "0",
    border: "none",
    background: "none",
    color: "select.text",
    fontSize: "11.5px",
    fontFamily: "inherit",
    cursor: "pointer",
    textDecoration: "underline",
    _disabled: { opacity: "0.5", cursor: "default" },
  });
</script>

<div
  data-path={field.path}
  class={cx(
    css({
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) minmax(0, 240px)",
      gap: "4px 18px",
      padding: "11px 14px",
      borderTop: "1px solid token(colors.neutral.border)",
      _first: { borderTop: "none" },
      "@media (max-width: 560px)": { gridTemplateColumns: "minmax(0, 1fr)" },
    }),
    changed && css({ backgroundColor: "select.surface" }),
  )}
>
  <div>
    <label for={id} class={css({ fontSize: "12.5px", fontWeight: "600", color: "ink.black" })}>
      {field.label}
      <span class={css({ marginLeft: "6px", fontFamily: "mono", fontSize: "10.5px", fontWeight: "400", color: "neutral.muted" })}>
        {field.path}
      </span>
    </label>
    <div class={css({ marginTop: "2px", fontSize: "11.5px", color: "neutral.subtle" })}>{field.help}</div>
  </div>

  <div class={css({ display: "flex", flexDirection: "column", gap: "5px" })}>
    {#if field.kind === "boolean"}
      <input
        {id}
        type="checkbox"
        {disabled}
        bind:checked
        onchange={() => onchange(checked)}
        class={css({ width: "16px", height: "16px", accentColor: "var(--colors-ink-black)", cursor: "pointer" })}
      />
    {:else if field.kind === "number"}
      <input
        {id}
        type="number"
        {disabled}
        min={field.min}
        max={field.max}
        step={field.integer ? 1 : "any"}
        placeholder={field.defaultValue === undefined ? "" : String(field.defaultValue)}
        bind:value={number}
        oninput={() => onchange(numberChange(number))}
        class={inputClass}
      />
    {:else if field.kind === "choice"}
      <select {id} {disabled} bind:value={choice} onchange={() => onchange(choice)} class={inputClass}>
        {#each field.choices ?? [] as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    {:else if field.kind === "list"}
      <textarea
        {id}
        {disabled}
        bind:value={text}
        oninput={() => onchange(parseListInput(text))}
        class={cx(inputClass, monoClass, css({ minHeight: "64px", resize: "vertical" }))}
      ></textarea>
    {:else if field.kind === "shortcut"}
      <div class={css({ display: "flex", gap: "6px" })}>
        <input
          {id}
          readonly
          {disabled}
          value={text}
          title="Select this field, then press a key"
          placeholder="Press a key"
          onkeydown={recordKey}
          class={cx(inputClass, monoClass, css({ cursor: "pointer" }))}
        />
        <button type="button" title="Disable this shortcut" {disabled} onclick={clearKey} class={smallButtonClass}>
          None
        </button>
      </div>
    {:else}
      <input
        {id}
        type="text"
        {disabled}
        placeholder={field.defaultValue === undefined ? "" : String(field.defaultValue)}
        bind:value={text}
        oninput={() => onchange(text)}
        class={inputClass}
      />
    {/if}

    {#if field.defaultValue !== undefined || field.min !== undefined || (!field.required && !usingDefault)}
      <div class={css({ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: "11.5px", color: "neutral.muted" })}>
        {#if field.defaultValue !== undefined}
          <span>Default: {describeValue(field, field.defaultValue)}</span>
        {/if}
        {#if field.min !== undefined}
          <span>Range: {field.min} to {field.max}</span>
        {/if}
        {#if !field.required && !usingDefault}
          <button type="button" {disabled} onclick={useDefault} class={linkButtonClass}>Use default</button>
        {/if}
      </div>
    {/if}
  </div>

  {#each issues as issue, index (index)}
    <div
      data-issue={issue.severity}
      class={cx(
        css({ gridColumn: "1 / -1", fontSize: "11.5px" }),
        issue.severity === "error" ? css({ color: "state.error" }) : css({ color: "neutral.subtle" }),
      )}
    >
      {issue.severity === "error" ? "✗" : "⚠"} {issue.message}
    </div>
  {/each}
</div>
