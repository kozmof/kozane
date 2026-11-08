import { expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import ClientNotice from "../src/ClientNotice.svelte";
it("does not infer lifetime or recovery from non-persistence alone", () => {
  const capabilities = {
    writable: true,
    persistent: false,
    taskspaces: false,
    auth: false,
    externalWrites: false,
  };
  render(ClientNotice, { props: { capabilities } });
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});
it("identifies read-only data without claiming a server lifetime", () => {
  render(ClientNotice, { props: { capabilities: { writable: false } } });
  expect(screen.getByLabelText("Workspace mode")).toHaveTextContent("Read-only workspace.");
  expect(screen.queryByText(/server process/)).not.toBeInTheDocument();
});
it("uses the host's lifetime wording without offering recovery controls", () => {
  render(ClientNotice, {
    props: {
      capabilities: { writable: true },
      lifetimeNotice: "Database changes last for this server process and are lost when it stops.",
    },
  });
  expect(screen.getByLabelText("Workspace mode")).toHaveTextContent("server process");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByText(/reload recovery|sessionStorage/)).not.toBeInTheDocument();
});
