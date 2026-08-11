import { listen } from "@tauri-apps/api/event";
import type { StatusToast } from "../shared/contracts";
import { EVENTS } from "../shared/contracts";
import "../shared/base.css";
import "./status.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Status root is missing");

app.innerHTML = `<div class="toast"><span id="status-icon">✓</span><strong id="status-message">自动翻译已开启</strong></div>`;

const icon = document.querySelector<HTMLElement>("#status-icon")!;
const message = document.querySelector<HTMLElement>("#status-message")!;
let latestGeneration = 0;

void listen<StatusToast>(EVENTS.statusToast, (event) => {
  if (event.payload.generation < latestGeneration) return;
  latestGeneration = event.payload.generation;
  icon.textContent = event.payload.enabled ? "✓" : "—";
  icon.classList.toggle("disabled", !event.payload.enabled);
  message.textContent = event.payload.message;
});
