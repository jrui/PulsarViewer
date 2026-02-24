# Pulsar Viewer
A lightweight desktop application with Go backend and web UI to quickly inspect payloads from an Apache Pulsar topic (read-only consumer). Connect using a service URL (broker or proxy), optional token authentication, and stream messages live.


<br>
<br>

## Installation Options
### Pre-built binaries
Download installers for **macOS**, **Windows**, and **Linux** from [Releases](https://github.com/jrui/PulsarViewer/releases).

**macOS:** If Gatekeeper blocks the app (“Apple could not verify … free of malware”), remove the quarantine attribute and open from the CLI:  
`xattr -cr "/Applications/PulsarViewer.app" && open "/Applications/PulsarViewer.app"`

<br>

### Docker
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
npm run dev
# Backend runs on http://localhost:3000
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


---
Made with ❤️ for quick troubleshooting.
