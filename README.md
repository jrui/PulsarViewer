# Pulsar Viewer
A lightweight desktop application with Go backend and web UI to quickly inspect payloads from an Apache Pulsar topic (read-only consumer). Connect using a service URL (broker or proxy), optional token authentication, and stream messages live.

<br>
<br>

## Architecture
- **Frontend**: Pure HTML/CSS/JavaScript web UI
- **Backend**: Go server with Apache Pulsar client
- **Desktop**: Tauri (Rust) for native app wrapper

<br>
<br>

## Installation Options
### Docker
Running with Docker:
```sh
docker pull ghcr.io/jrui/pulsarviewer:latest
docker run --rm -p 3000:3000 ghcr.io/jrui/pulsarviewer
```
Then open http://localhost:3000 in your browser.

<br>
<br>

## Local Development
### Run Backend + Frontend
```bash
# Terminal 1: Start Go backend
cd src/backend
go run ./cmd/main.go

# Backend runs on http://localhost:3000
# Open in browser or continue to run desktop app
```

<br>

### Run Tauri Desktop App
```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri:dev
```

<br>
<br>

## Building Desktop Apps
### Prerequisites
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Node dependencies
npm install
```

<br>

### Build for your platform
```bash
# macOS universal (Intel + Apple Silicon)
npm run tauri:build -- --target universal-apple-darwin

# Linux x64
npm run tauri:build -- --target x86_64-unknown-linux-gnu

# Windows x64
npm run tauri:build -- --target x86_64-pc-windows-msvc
```

Artifacts will be in `src-tauri/target/{target}/release/bundle/`

<br>
<br>

## Usage (UI)
### Viewing messages
1. Enter Service URL (e.g. `pulsar://localhost:6650` or `pulsar+ssl://my.cluster:6651`)
2. Enter fully qualified topic (e.g. `persistent://public/default/my-topic`)
3. (Optional) Paste token (stored in browser localStorage for web, in-memory for desktop)
4. Adjust subscription name / type if desired
5. Click Connect – messages stream live
6. Use Filter to show only messages containing specific text (supports regex with toggle)

<br>

### Sending messages
1. Fill in Service URL, Topic, Payload, (optional) Key, Properties (JSON), and Token in the send form
2. Click Send Message
3. Success or error will be shown in the message log

<br>
<br>

---
Made with ❤️ for quick troubleshooting.