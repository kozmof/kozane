<script lang="ts">
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";

  let { data }: PageProps = $props();
</script>

<main class={css({ padding: "48px", backgroundColor: "ink.lighter", minHeight: "100vh" })}>
  <h1 class={css({ fontSize: "14px", fontWeight: "400", fontFamily: "mono", color: "neutral.muted", marginBottom: "24px" })}>
    {data.workspaceRoot}
  </h1>

  {#if data.projects.length === 0}
    <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>
      No projects yet. Run
      <code class={css({ fontFamily: "mono", fontSize: "12px", backgroundColor: "neutral.bg", padding: "2px 6px", borderRadius: "3px" })}>
        kozane project create &lt;name&gt;
      </code>
      to create one.
    </p>
  {:else}
    <ul class={css({ listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" })}>
      {#each data.projects as project (project.id)}
        <li>
          <a
            href="/{project.id}"
            class={css({
              color: "ink.black",
              textDecoration: "none",
              fontSize: "14px",
              padding: "10px 14px",
              background: "ink.white",
              border: "1px solid token(colors.neutral.border)",
              borderRadius: "7px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              transition: "border-color 0.1s",
              _hover: { borderColor: "neutral.muted" },
            })}
          >
            <span>{project.name}</span>
            {#if project.isDefault}
              <span
                class={css({
                  color: "neutral.muted",
                  backgroundColor: "neutral.bg",
                  display: "inline-flex",
                  alignItems: "center",
                  minHeight: "20px",
                  borderRadius: "999px",
                  padding: "2px 8px",
                  fontFamily: "mono",
                  fontSize: "11px",
                  lineHeight: "1",
                })}
              >
                Default
              </span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</main>
