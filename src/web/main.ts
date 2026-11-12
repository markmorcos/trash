import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { init } from "./lib/app.svelte";
import "./lib/install.svelte"; // catch the install prompt before it fires

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker failed", e));
}

mount(App, { target: document.getElementById("app")! });
void init();
