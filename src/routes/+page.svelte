<script lang="ts">
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";

  let { data }: PageProps = $props();
</script>

<main class={css({ padding: "48px", backgroundColor: "ink.lighter", minHeight: "100vh" })}>
  <h1 class={css({ fontSize: "20px", fontWeight: "500", letterSpacing: "-0.02em", marginBottom: "24px" })}>
    kozane
    <span class={css({ fontSize: "12px", color: "warm.muted", letterSpacing: "0.04em", fontWeight: "400", marginLeft: "8px" })}>
      こざね
    </span>
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
              background: "#fff",
              border: "1px solid #e6e1d8",
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
