# Pulsar Payload Viewer
A lightweight TypeScript + Express web UI to quickly inspect payloads from an Apache Pulsar topic (read-only consumer). Connect using a service URL (broker or proxy), optional token authentication, and stream messages live via Server-Sent Events.



## Local Pulsar Viewer
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



## Requirements
- Node.js 18+
- Access to a Pulsar cluster (direct broker `pulsar://` or proxy / SSL `pulsar+ssl://`)
- If using token authentication, a valid JWT



## Local Development
```bash
npm run dev
# Open http://localhost:3000
```



## Usage (UI)
### Viewing messages
1. Enter Service URL (e.g. `pulsar://localhost:6650` or `pulsar+ssl://my.cluster:6651`)
2. Enter fully qualified topic (e.g. `persistent://public/default/my-topic`)
3. (Optional) Paste token (kept only in-memory; not stored)
4. Adjust subscription name / type if desired
5. Click Connect – messages appear live
6. Use Pause to temporarily stop rendering (messages still consumed)
7. Use Clear to wipe current display


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

- `filter` a substring used to filter incoming messages. When provided, only messages whose stringified payload contains this substring will be sent over the SSE stream. This can also be set from the UI using the new "Filter" field in the connection form.



---
Made with ❤️ for quick troubleshooting.