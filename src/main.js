const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const PORTAL_SLUG = "portal";
const PORTAL_URL = "http://localhost:3000";
const ICONS = { pending: "○", ready: "✓", timeout: "✗", exited: "✗" };
const READY_TIMEOUT_MS = 20_000;

// slug -> { port, state }
const apps = new Map();

// Visible on-screen log: this app has no way to open dev tools without
// accessibility permissions granted, so if something goes wrong, a plain
// console.error is invisible. Show it directly on the boot screen instead.
function log(message) {
  const el = document.querySelector("#debug-log");
  if (!el) return;
  const line = document.createElement("div");
  const time = new Date().toISOString().split("T")[1].replace("Z", "");
  line.textContent = `[${time}] ${message}`;
  el.appendChild(line);
}

function render() {
  const list = document.querySelector("#status-list");
  list.innerHTML = "";
  let readyCount = 0;
  for (const [slug, info] of apps) {
    const li = document.createElement("li");
    li.className = `state-${info.state}`;
    li.textContent = `${ICONS[info.state] ?? "○"} ${slug} (:${info.port})`;
    list.appendChild(li);
    if (info.state === "ready") readyCount += 1;
  }

  const total = apps.size;
  const pct = total > 0 ? Math.round((readyCount / total) * 100) : 0;
  document.querySelector("#progress-fill").style.width = `${pct}%`;
  document.querySelector("#progress-caption").textContent =
    total > 0 ? `${readyCount} of ${total} ready…` : "Starting…";
}

function showPortal() {
  const frame = document.querySelector("#portal-frame");
  // Cache-bust: the app window's WebView data store persists across
  // launches (unlike a fresh browser tab), so a stale cached response -
  // e.g. a transient 404 caught mid-restart during dev-mode iteration -
  // could otherwise keep being served instead of a fresh request.
  frame.src = `${PORTAL_URL}/?_t=${Date.now()}`;
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
    log(`manifest: ${payload.apps.length} apps`);
    render();
    return;
  }

  const existing = apps.get(payload.slug);
  apps.set(payload.slug, { port: payload.port ?? existing?.port, state: payload.state });
  log(`${payload.slug}: ${payload.state}`);
  render();

  if (payload.slug === PORTAL_SLUG && payload.state === "ready") {
    log("portal ready - showing it");
    showPortal();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#details-toggle").addEventListener("click", () => {
    document.querySelector("#boot-screen").classList.toggle("details-open");
  });

  log("page loaded, registering listeners");

  // Register listeners before pulling the snapshot below, so nothing
  // that arrives in between is missed.
  listen("app-status", (event) => handleStatus(event.payload)).catch((err) =>
    log(`listen(app-status) failed: ${JSON.stringify(err)}`),
  );
  listen("restarting", () => {
    for (const info of apps.values()) info.state = "pending";
    render();
    showBootScreen();
  }).catch((err) => log(`listen(restarting) failed: ${JSON.stringify(err)}`));
  listen("orchestrator-log", (event) => log(`[orchestrator] ${event.payload}`)).catch((err) =>
    log(`listen(orchestrator-log) failed: ${JSON.stringify(err)}`),
  );

  // Same buffered-then-live pattern as get_status below: an early spawn
  // failure can log before this page is ready to listen for it live.
  invoke("get_log")
    .then((lines) => {
      for (const line of lines) log(`[orchestrator] ${line}`);
    })
    .catch((err) => log(`get_log FAILED: ${JSON.stringify(err)}`));

  // The orchestrator can emit its manifest and early ready events before
  // this page has finished loading and registered the listeners above -
  // Tauri doesn't replay missed events. Pull current state explicitly to
  // catch up on anything already missed. HashMap iteration order on the
  // Rust side isn't guaranteed, so apply the manifest first regardless of
  // array order, then the rest.
  log("calling get_status");
  invoke("get_status")
    .then((payloads) => {
      log(`get_status resolved: ${payloads.length} entries`);
      const manifest = payloads.find((p) => p.type === "manifest");
      if (manifest) handleStatus(manifest);
      for (const payload of payloads) {
        if (payload.type !== "manifest") handleStatus(payload);
      }
    })
    .catch((err) => log(`get_status FAILED: ${JSON.stringify(err)}`));

  setTimeout(() => {
    if (!document.body.classList.contains("portal-ready")) {
      log(`still not ready after ${READY_TIMEOUT_MS / 1000}s - see lines above for where it stalled`);
      document.querySelector("#boot-screen").classList.add("details-open");
    }
  }, READY_TIMEOUT_MS);
});
