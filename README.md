## Docker Deployment

Build and run locally:
```sh
docker build -t pulsarviewer .
docker run -p 3000:3000 pulsarviewer
```

## Automatic GitHub Packages Deployment

On every push to `main`, GitHub Actions will build and publish the Docker image to GitHub Packages:
```
ghcr.io/<your-username>/pulsarviewer:latest
```
See `.github/workflows/docker-publish.yml` for details.
# Pulsar Payload Viewer

A lightweight TypeScript + Express web UI to quickly inspect payloads from an Apache Pulsar topic (read-only consumer). Connect using a service URL (broker or proxy), optional token authentication, and stream messages live via Server-Sent Events.

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

## Install
```bash
npm install
```

## Development
```bash
npm run dev
# Open http://localhost:3000
```

## Build & Run
```bash
npm run build
npm start
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

## Security Notes
- Token is only transmitted as a query parameter for this prototype. For production, prefer POST body or Authorization header.
- No persistence. Each browser tab creates its own short-lived consumer.
- Consider rate limiting / auth if exposing publicly.

## Limitations
- Basic JSON highlighting (no full syntax highlighter)
- Back-pressure not exposed to UI; very high throughput topics may cause memory growth if rendering is slower than consumption.
- Single-threaded Node process; scale out with a reverse proxy if needed.

## Adapting
To add schema decoding (Avro/Protobuf), extend `pulsarService.ts` to integrate with Pulsar schema or external registry, then transform `data` before emitting.

## License
ISC

---
Made with ❤️ for quick troubleshooting.

## Troubleshooting

### AuthorizationError
Causes:
- Token lacks `consume` permission for namespace/topic.
- Using broker URL requiring TLS with non-TLS scheme.
- Token passed but broker expects different auth method.

Steps:
1. Verify topic: `pulsar-admin topics list public/default` (adjust namespace).
2. Confirm role / token permissions: `pulsar-admin namespaces permissions public/default`.
3. If using a Pulsar proxy, ensure you use the proxy URL not direct broker.
4. Try without token if topic is public to isolate auth layer.
5. Enable verbose: append `&verbose=1` to stream URL and check server logs.
6. For TLS clusters, use `pulsar+ssl://` scheme and ensure CA trust (set `PULSAR_CLIENT_CERTS` if needed - not yet wired here).

If issues persist, capture: serviceUrl, namespace policy, auth mechanism, and the first 4 + last 4 chars of token (never the full token) for debugging.
