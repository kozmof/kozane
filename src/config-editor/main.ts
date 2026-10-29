import { mount } from "svelte";
import "../app.css";
import App from "./App.svelte";

// The server prints a link carrying the session token. Every API request sends it back.
const token = new URLSearchParams(window.location.search).get("token");

mount(App, { target: document.getElementById("app")!, props: { token } });
