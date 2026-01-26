// Tauri app for PulsarViewer with Go backend

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;

fn main() {
    // Only start backend in production (bundled app)
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
    use std::process::Command;
    
    std::thread::spawn(|| {
        // Get the app's executable directory
        let exe_path = std::env::current_exe().unwrap_or_default();
        let exe_dir = exe_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
        
        // On macOS, the structure is: PulsarViewer.app/Contents/MacOS/pulsarviewer (executable)
        // Resources are at: PulsarViewer.app/Contents/Resources/
        // Tauri puts resources in _up_ subdirectory
        let resource_paths = vec![
            exe_dir.join("../Resources/_up_/src/backend/pulsarviewer-backend"),
            exe_dir.join("../Resources/src/backend/pulsarviewer-backend"),
            exe_dir.join("../Resources/_up_/pulsarviewer-backend"),
            exe_dir.join("../Resources/pulsarviewer-backend"),
            exe_dir.join("../../Resources/_up_/pulsarviewer-backend"),
            exe_dir.join("../../Resources/pulsarviewer-backend"),
            exe_dir.join("pulsarviewer-backend"),
            PathBuf::from("./pulsarviewer-backend"),
        ];
        
        let mut backend_path = PathBuf::new();
        for path in &resource_paths {
            eprintln!("[Tauri] Checking for backend at: {:?}", path);
            if path.exists() {
                backend_path = path.clone();
                eprintln!("[Tauri] Found backend at: {:?}", backend_path);
                break;
            }
        }
        
        if backend_path.as_os_str().is_empty() {
            eprintln!("[Tauri] Backend binary not found in any expected location");
            eprintln!("[Tauri] Exe path: {:?}", exe_path);
            eprintln!("[Tauri] Exe dir: {:?}", exe_dir);
            return;
        }

        eprintln!("[Tauri] Starting backend: {:?}", backend_path);
        match Command::new(&backend_path).spawn() {
            Ok(mut child) => {
                eprintln!("[Tauri] Backend process started successfully");
                let _ = child.wait();
                eprintln!("[Tauri] Backend process exited");
            }
            Err(e) => eprintln!("[Tauri] Failed to start backend: {}", e),
        }
    });

    // Give backend time to start
    std::thread::sleep(std::time::Duration::from_secs(3));
}

