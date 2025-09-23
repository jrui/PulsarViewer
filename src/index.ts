import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { PulsarConsumerWrapper, PulsarProducerWrapper } from './pulsarService';


const app = express();
app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Basic health endpoint
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

interface StreamQuery {
	serviceUrl?: string;
	token?: string;
	topic?: string;
	subscription?: string;
	subscriptionType?: string;
	verbose?: string; // '1' to enable
	filter?: string; // substring filter for messages
}


// Send message endpoint
app.post('/api/send', async (req: Request, res: Response) => {
	const { serviceUrl, token, topic, payload, key, properties, verbose } = req.body || {};
	if (!serviceUrl || !topic || !payload) {
		res.status(400).json({ error: 'Missing serviceUrl, topic, or payload' });
		return;
	}
	const producer = new PulsarProducerWrapper({ serviceUrl, token, topic, verbose });
	try {
		await producer.connect();
		const result = await producer.send({ payload, key, properties });
		await producer.close();
		res.json({ ok: true, messageId: result.messageId });
	} catch (e: any) {
		await producer.close().catch(() => {});
		res.status(500).json({ error: e.message || String(e) });
	}
});


// Server-Sent Events endpoint: /api/stream?serviceUrl=&topic=&token=&subscription=
app.get('/api/stream', async (req: Request, res: Response) => {
	const q: StreamQuery = req.query as any;
	if (!q.serviceUrl || !q.topic) {
		res.status(400).json({ error: 'Missing serviceUrl or topic' });
		return;
	}
	const subscription = q.subscription || 'viewer-sub';
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	});

	const consumer = new PulsarConsumerWrapper({
		serviceUrl: q.serviceUrl,
		token: q.token,
		topic: q.topic,
		subscription,
		subscriptionType: (q.subscriptionType as any) || 'Exclusive',
		initialPosition: (req.query.initialPosition as any) || undefined,
		verbose: q.verbose === '1',
	});

	const send = (event: string, data: any) => {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	send('info', { message: 'Connecting to Pulsar...' });
	try {
		await consumer.connect();
		send('info', { message: 'Connected. Streaming messages.' });
		(async () => {
			const f = q.filter;
			for await (const m of consumer.messageStream()) {
				try {
					// If a filter is provided, only send messages that include the substring.
					if (f && f.length > 0) {
						const s = typeof m === 'string' ? m : JSON.stringify(m);
						if (!s.includes(f)) continue;
					}
				} catch (err) {
					// If stringification fails, and verbose, send error info and skip
					if (q.verbose === '1') {
						send('error', { error: 'Failed to apply filter to message', detail: String(err) });
					}
					continue;
				}
				send('message', m);
			}
		})();
	} catch (e: any) {
		const detail: any = { error: e.message || String(e) };
		if (q.verbose === '1') {
			detail.stack = e.stack;
			if (e.cause) detail.cause = String(e.cause?.message || e.cause);
		}
		send('error', detail);
	}

	req.on('close', () => {
		consumer.close().catch(() => {});
	});
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

// Start server and keep a reference so we can close it on shutdown
const server = app.listen(port, host, () => {
	console.log(`Pulsar viewer server running in container on http://${host}:${port}`);
	console.log(`Map the port to your host with: docker run -p ${port}:${port} <image>`);
});

// Track open sockets so we can forcefully destroy them (SSE keeps connections open)
const sockets = new Set<any>();
server.on('connection', (socket) => {
	sockets.add(socket);
	socket.on('close', () => sockets.delete(socket));
});

const shutdown = (signal: string) => {
	console.log(`Received ${signal}, shutting down server...`);
	// Stop accepting new connections
	server.close(() => {
		console.log('HTTP server closed. Exiting.');
		process.exit(0);
	});

	// Force-close any open sockets (SSE) so server.close callback can run
	for (const s of sockets) {
		try { s.destroy(); } catch { /* ignore */ }
	}

	// If still not exiting, force exit after timeout
	setTimeout(() => {
		console.error('Forcing shutdown after timeout.');
		process.exit(1);
	}, 10000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));