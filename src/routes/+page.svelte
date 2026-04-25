<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<main>
  <h1>Kozane</h1>

  {#if data.projects.length === 0}
    <p>No projects yet.</p>
  {:else}
    <ul>
      {#each data.projects as project (project.id)}
        <li>
          <strong>{project.name}</strong>
          <span class="project-id"> — {project.id}</span>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  .project-id {
    color: gray;
    font-size: 0.8em;
  }
</style>
