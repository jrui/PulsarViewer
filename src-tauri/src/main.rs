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
        .invoke_handler(tauri::generate_handler![save_export_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Opens a native "Save As" dialog and writes `content` to the chosen path.
/// Returns the saved file path, or an empty string if the user cancelled.
#[tauri::command]
fn save_export_file(default_name: String, content: String) -> Result<String, String> {
    use tauri::api::dialog::blocking::FileDialogBuilder;

    let path = FileDialogBuilder::new()
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .save_file();

    match path {
        Some(path) => {
            std::fs::write(&path, content).map_err(|e| e.to_string())?;
            Ok(path.to_string_lossy().to_string())
        }
        None => Ok(String::new()),
    }
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

