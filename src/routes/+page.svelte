<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<main>
  <h1>kozane <span>こざね</span></h1>

  {#if data.projects.length === 0}
    <p>No projects yet. Run <code>kozane init</code> to create one.</p>
  {:else}
    <ul>
      {#each data.projects as project (project.id)}
        <li>
          <a href="/{project.id}">{project.name}</a>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  main {
    padding: 48px;
    background: #f2f2f2;
    min-height: 100vh;
  }

  h1 {
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.02em;
    margin-bottom: 24px;
  }

  h1 span {
    font-size: 12px;
    color: #b0aaa2;
    letter-spacing: 0.04em;
    font-weight: 400;
    margin-left: 8px;
  }

  ul {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  a {
    color: #1c1a17;
    text-decoration: none;
    font-size: 14px;
    padding: 10px 14px;
    background: #fff;
    border: 1px solid #e6e1d8;
    border-radius: 7px;
    display: block;
    transition: border-color 0.1s;
  }

  a:hover {
    border-color: #b0aaa2;
  }

  p {
    color: #9e9890;
    font-size: 13px;
  }

  code {
    font-family: "IBM Plex Mono", monospace;
    font-size: 12px;
    background: #ede9e1;
    padding: 2px 6px;
    border-radius: 3px;
  }
</style>
