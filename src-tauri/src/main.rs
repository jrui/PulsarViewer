// Tauri app for PulsarViewer with Go backend

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    // Only start backend in production (bundled app) via Tauri sidecar
    // In dev mode, beforeDevCommand handles starting the backend
    #[cfg(not(debug_assertions))]
    start_backend();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(not(debug_assertions))]
fn start_backend() {
    use tauri::api::process::Command;
    
    std::thread::spawn(|| {
        match Command::new_sidecar("pulsarviewer-backend") {
            Ok(cmd) => {
                if let Err(e) = cmd.spawn() {
                    eprintln!("[Tauri] Failed to start backend sidecar: {}", e);
                } else {
                    eprintln!("[Tauri] Backend sidecar started");
                }
            }
            Err(e) => eprintln!("[Tauri] Failed to create backend sidecar command: {}", e),
        }
    });

    // Give backend time to start
    std::thread::sleep(std::time::Duration::from_secs(3));
}

