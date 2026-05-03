<script lang="ts">
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";

  let { data }: PageProps = $props();
</script>

<main class={css({ padding: "48px", backgroundColor: "ink.lighter", minHeight: "100vh" })}>
  <h1 class={css({ fontSize: "14px", fontWeight: "400", fontFamily: "mono", color: "warm.muted", marginBottom: "24px" })}>
    {data.workspaceRoot}
  </h1>

  {#if data.projects.length === 0}
    <p class={css({ color: "warm.subtle", fontSize: "13px" })}>
      No projects yet. Run
      <code class={css({ fontFamily: "mono", fontSize: "12px", backgroundColor: "warm.bg", padding: "2px 6px", borderRadius: "3px" })}>
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
              border: "1px solid token(colors.warm.border)",
              borderRadius: "7px",
              display: "block",
              transition: "border-color 0.1s",
              _hover: { borderColor: "warm.muted" },
            })}
          >
            {project.name}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</main>
