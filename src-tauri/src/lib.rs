use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

const PORTAL_DIR: &str = "/Users/laci/workspace/upwithagents/upwithagents-portal";
const PORTAL_URL: &str = "http://localhost:3000";
// GUI-launched apps get a minimal PATH that doesn't include Homebrew -
// same issue and same fix as the shell-script launcher.
const DEV_PATH_PREFIX: &str = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin";

struct OrchestratorState(Mutex<Option<Child>>);

fn spawn_orchestrator(app: &AppHandle) {
    let path = format!(
        "{}:{}",
        DEV_PATH_PREFIX,
        std::env::var("PATH").unwrap_or_default()
    );
    let mut child = Command::new("pnpm")
        .arg("dev")
        .current_dir(PORTAL_DIR)
        .env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // pnpm -> tsx's CLI wrapper -> the actual orchestrator script is a
        // 3-layer chain, and none of those layers reliably forward signals
        // to their child. Put the whole chain in its own process group (id
        // == this child's pid) so a single signal to -pid reaches every
        // process in the tree directly, instead of depending on each
        // wrapper layer to relay it.
        .process_group(0)
        .spawn()
        .expect("failed to spawn orchestrator");

    let stdout = child.stdout.take().expect("orchestrator has no stdout");
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(json_str) = line.strip_prefix("@@STATUS@@") {
                if let Ok(payload) = serde_json::from_str::<Value>(json_str) {
                    let _ = app_handle.emit("app-status", payload);
                }
            }
        }
    });

    let state: State<OrchestratorState> = app.state();
    *state.0.lock().unwrap() = Some(child);
}

// Sends SIGTERM to the orchestrator's whole process group (not just its
// immediate pid, and not Child::kill()'s SIGKILL) - the pnpm/tsx wrapper
// chain doesn't reliably forward signals to its own children, but every
// process in the group (set up via process_group(0) above) receives a
// group-targeted signal directly from the kernel regardless.
fn kill_orchestrator(app: &AppHandle) {
    let state: State<OrchestratorState> = app.state();
    let mut guard = state.0.lock().unwrap();
    if let Some(child) = guard.take() {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(format!("-{}", child.id()))
            .status();
    }
}

fn restart(app: &AppHandle) {
    kill_orchestrator(app);
    let _ = app.emit("restarting", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        spawn_orchestrator(&handle);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(OrchestratorState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            spawn_orchestrator(&handle);

            let status_item =
                MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?;
            let open_browser =
                MenuItem::with_id(app, "open_browser", "Open in Browser", true, None::<&str>)?;
            let restart_item =
                MenuItem::with_id(app, "restart", "Restart All", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &status_item,
                    &PredefinedMenuItem::separator(app)?,
                    &open_browser,
                    &restart_item,
                    &quit_item,
                ],
            )?;

            TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open_browser" => {
                        let _ = Command::new("open").arg(PORTAL_URL).status();
                    }
                    "restart" => restart(app),
                    "quit" => {
                        kill_orchestrator(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle().clone();
                kill_orchestrator(&app);
                app.exit(0);
            }
        })
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
