# Pulsar Viewer
A lightweight TypeScript + Express web UI to quickly inspect payloads from an Apache Pulsar topic (read-only consumer). Connect using a service URL (broker or proxy), optional token authentication, and stream messages live via Server-Sent Events.



## Installation Options

### Desktop Apps
Download the latest desktop application for your platform:

- **[macOS (DMG)](https://github.com/jrui/PulsarViewer/releases/latest)** - Download PulsarViewer-*.dmg
	- Note: You may need to open the app with `xattr -cr /Applications/PulsarViewer.app && open -a PulsarViewer` the first time
- **[Linux (AppImage)](https://github.com/jrui/PulsarViewer/releases/latest)** - Download PulsarViewer-*.AppImage
- **[Windows (EXE)](https://github.com/jrui/PulsarViewer/releases/latest)** - Download PulsarViewer-*.exe

Or browse all releases at [GitHub Releases](https://github.com/jrui/PulsarViewer/releases)

**Installation:**
- **macOS**: Open the DMG and drag PulsarViewer to Applications
- **Linux**: Make the AppImage executable: `chmod +x PulsarViewer-*.AppImage` then run it
- **Windows**: Run the installer EXE

The desktop apps include a built-in web server and open automatically in a native window.

### Docker
Running locally with docker:
```sh
docker pull ghcr.io/jrui/pulsarviewer:latest
docker run --rm -p 3000:3000 ghcr.io/jrui/pulsarviewer
```



## Features
- Live streaming of messages (SSE)
- Send messages to Pulsar topics (producer)
- Auto JSON parsing (raw retained if invalid)
- View message metadata (id, publish time, key, properties)
- Auto-scroll toggle & pause
- Clear messages & running counter
- Supports Exclusive/Shared/Failover/KeyShared subscription types
- Client-side message filtering with substring or regex matching
- Dynamic filter updates without reconnection



## Requirements
- Node.js 18+
- Access to a Pulsar cluster (direct broker `pulsar://` or proxy / SSL `pulsar+ssl://`)
- If using token authentication, a valid JWT



## Local Development
```bash
npm install
npm run dev
```
This starts the Electron app in development mode with hot reload.

## Building Desktop Apps
To build installers locally:
```bash
npm run build:electron
```
This creates platform-specific installers in the `dist/` folder:
- macOS: DMG and ZIP
- Linux: AppImage and DEB
- Windows: EXE installer



## Usage (UI)
### Viewing messages
1. Enter Service URL (e.g. `pulsar://localhost:6650` or `pulsar+ssl://my.cluster:6651`)
2. Enter fully qualified topic (e.g. `persistent://public/default/my-topic`)
3. (Optional) Paste token (kept only in-memory; not stored)
4. Adjust subscription name / type if desired
5. Click Connect – messages appear live
6. Use Pause to temporarily stop rendering (messages still consumed)
7. Use Clear to wipe current display
8. Use Filter to show only messages containing specific text (supports regex with toggle)


### Sending messages
1. Fill in Service URL, Topic, Payload, (optional) Key, Properties (JSON), and Token in the send form
2. Click Send Message
3. Success or error will be shown in the message log



## SSE Endpoint (programmatic)
## Producer API (programmatic)
`POST /api/send`
Body (JSON):
```
{
	"serviceUrl": "pulsar+ssl://...:6651",
	"topic": "persistent://gpd/trading-services/refresh",
	"payload": "your message string",
	"key": "optional-key",
	"properties": { "foo": "bar" },
	"token": "your JWT token"
}
```

Response:
```
{ "ok": true, "messageId": "..." }
```
or
```
{ "error": "..." }
```
`GET /api/stream?serviceUrl=...&topic=...&subscription=viewer-sub&subscriptionType=Exclusive&initialPosition=earliest&verbose=1&token=...`

Events emitted:
- `info` – status messages
- `message` – Pulsar message object `{ id, publishTime, eventTime, properties, key, data, json }`
- `error` – connection / consumer errors

Query params (optional):
- `subscriptionType` one of Exclusive|Shared|Failover|KeyShared
- `initialPosition` earliest|latest (default latest)
- `verbose=1` includes stack traces / extra diagnostics



---
Made with ❤️ for quick troubleshooting.