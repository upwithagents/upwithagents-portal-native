const { listen } = window.__TAURI__.event;

const PORTAL_SLUG = "portal";
const PORTAL_URL = "http://localhost:3000";
const ICONS = { pending: "○", ready: "✓", timeout: "✗", exited: "✗" };

// slug -> { port, state }
const apps = new Map();

function render() {
  const list = document.querySelector("#status-list");
  list.innerHTML = "";
  for (const [slug, info] of apps) {
    const li = document.createElement("li");
    li.className = `state-${info.state}`;
    li.textContent = `${ICONS[info.state] ?? "○"} ${slug} (:${info.port})`;
    list.appendChild(li);
  }
}

function showPortal() {
  const frame = document.querySelector("#portal-frame");
  frame.src = PORTAL_URL;
  document.body.classList.add("portal-ready");
}

function showBootScreen() {
  const frame = document.querySelector("#portal-frame");
  frame.src = "about:blank";
  document.body.classList.remove("portal-ready");
}

function handleStatus(payload) {
  if (payload.type === "manifest") {
    apps.clear();
    for (const app of payload.apps) {
      apps.set(app.slug, { port: app.port, state: "pending" });
    }
    render();
    return;
  }

  const existing = apps.get(payload.slug);
  apps.set(payload.slug, { port: payload.port ?? existing?.port, state: payload.state });
  render();

  if (payload.slug === PORTAL_SLUG && payload.state === "ready") {
    showPortal();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  listen("app-status", (event) => handleStatus(event.payload));
  listen("restarting", () => {
    for (const info of apps.values()) info.state = "pending";
    render();
    showBootScreen();
  });
});
