import { app, BrowserWindow, ipcMain, safeStorage, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { PulsarConsumerWrapper, PulsarProducerWrapper } from './pulsarService';
import Store from 'electron-store';

const store = new Store();

let mainWindow: BrowserWindow | null;
const expressApp = express();
let server: any;

// Auto-updater configuration
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = console;

autoUpdater.on('checking-for-update', () => {
	console.log('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
	console.log('Update available:', info.version);
	if (mainWindow) {
		dialog.showMessageBox(mainWindow, {
			type: 'info',
			title: 'Update Available',
			message: `A new version (${info.version}) is available!`,
			detail: 'Would you like to download and install it now?',
			buttons: ['Download', 'Later'],
			defaultId: 0,
			cancelId: 1,
		}).then((result) => {
			if (result.response === 0) {
				autoUpdater.downloadUpdate();
			}
		});
	}
});

autoUpdater.on('update-not-available', (info) => {
	console.log('Update not available. Current version is the latest:', info.version);
});

autoUpdater.on('update-downloaded', () => {
	console.log('Update downloaded');
	if (mainWindow) {
		dialog.showMessageBox(mainWindow, {
			type: 'info',
			title: 'Update Ready',
			message: 'Update downloaded successfully!',
			detail: 'The application will restart to install the update.',
			buttons: ['Restart Now', 'Later'],
			defaultId: 0,
			cancelId: 1,
		}).then((result) => {
			if (result.response === 0) {
				autoUpdater.quitAndInstall();
			}
		});
	}
});

autoUpdater.on('error', (err) => {
	console.error('Update error:', err);
	if (mainWindow && app.isPackaged) {
		dialog.showErrorBox('Update Error', 'Failed to check for updates: ' + err.message);
	}
});

autoUpdater.on('download-progress', (progressObj) => {
	const logMessage = `Download progress: ${Math.round(progressObj.percent)}% (${progressObj.transferred}/${progressObj.total})`;
	console.log(logMessage);
});

// Setup Express middleware
expressApp.use(cors());
expressApp.use(express.json());

const publicDir = path.join(__dirname, '..', 'public');
expressApp.use(express.static(publicDir));

// Health endpoint
expressApp.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

interface StreamQuery {
	serviceUrl?: string;
	token?: string;
	topic?: string;
	subscription?: string;
	subscriptionType?: string;
	verbose?: string;
	filter?: string;
}

// Send message endpoint
expressApp.post('/api/send', async (req: Request, res: Response) => {
	const { serviceUrl, token, topic, payload, key, properties, verbose } = req.body || {};

	if (!serviceUrl || !topic || !payload) {
		return res.status(400).json({
			success: false,
			error: 'Missing required fields: serviceUrl, topic, payload',
		});
	}

	try {
		const producer = new PulsarProducerWrapper({
			serviceUrl,
			token,
			topic,
			verbose: verbose === '1',
		});
		await producer.connect();
		const result = await producer.send({ payload, key, properties });
		await producer.close();

		return res.json({
			success: true,
			...result,
			message: 'Message sent successfully',
		});
	} catch (error: any) {
		console.error('Error sending message:', error);
		return res.status(400).json({
			success: false,
			error: error.message,
		});
	}
});

// Stream messages endpoint
expressApp.get('/api/stream', async (req: Request, res: Response) => {
	const { serviceUrl, token, topic, subscription, subscriptionType, verbose, filter } =
		(req.query as unknown as StreamQuery) || {};

	if (!serviceUrl || !topic || !subscription) {
		return res.status(400).json({
			success: false,
			error: 'Missing required query params: serviceUrl, topic, subscription',
		});
	}

	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');

	const consumer = new PulsarConsumerWrapper({
		serviceUrl,
		token,
		topic,
		subscription,
		subscriptionType: (subscriptionType as any) || 'Exclusive',
		verbose: verbose === '1',
	});

	try {
		await consumer.connect();

		// Set up message stream listener
		(async () => {
			try {
				for await (const msgInfo of consumer.messageStream()) {
					if (filter && !msgInfo.data.includes(filter)) {
						continue;
					}

					const data = {
						messageId: msgInfo.id,
						timestamp: msgInfo.publishTime,
						eventTime: msgInfo.eventTime,
						key: msgInfo.key,
						properties: msgInfo.properties,
						payload: msgInfo.data,
						json: msgInfo.json,
					};

					if (verbose === '1') {
						console.log(`[CONSUMER] Received message: ${JSON.stringify(data)}`);
					}

					res.write(`data: ${JSON.stringify(data)}\n\n`);
				}
			} catch (error: any) {
				console.error('Error in message stream:', error);
				if (!res.writableEnded) {
					res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
					res.end();
				}
			}
		})();

		// Handle client disconnect
		req.on('close', () => {
			consumer.close().catch((error: any) => console.error('Error closing consumer:', error));
		});
	} catch (error: any) {
		console.error('Error in stream endpoint:', error);
		res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
		res.end();
		consumer.close().catch((error: any) => console.error('Error closing consumer:', error));
	}
});

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 800,
		minHeight: 600,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			nodeIntegration: false,
			contextIsolation: true,
		},
		icon: path.join(__dirname, '..', 'public', 'pulsar_viewer_logo.png'),
	});

	// Load local server
	mainWindow.loadURL('http://localhost:3000');

	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	// Open DevTools in development
	if (process.env.NODE_ENV === 'development') {
		mainWindow.webContents.openDevTools();
	}

	// Add keyboard shortcut to toggle DevTools (Cmd+Option+I on Mac, Ctrl+Shift+I on Windows/Linux)
	mainWindow.webContents.on('before-input-event', (event, input) => {
		if (input.type === 'keyDown') {
			const isMac = process.platform === 'darwin';
			const toggleDevTools = isMac
				? input.meta && input.alt && input.key.toLowerCase() === 'i'
				: input.control && input.shift && input.key.toLowerCase() === 'i';
			
			if (toggleDevTools) {
				mainWindow?.webContents.toggleDevTools();
			}
		}
	});
}

app.on('ready', () => {
	// Set up IPC handlers for credentials
	ipcMain.handle('save-connection', (_event, label, credentials) => {
		const { serviceUrl, topic, subscription, subscriptionType, token } = credentials;
		
		// Get existing connections
		const connections = (store.get('connections', {}) as any) || {};
		
		// Save connection data
		connections[label] = {
			serviceUrl,
			topic,
			subscription,
			subscriptionType,
		};
		
		// Encrypt and save token separately
		if (token && safeStorage.isEncryptionAvailable()) {
			const encrypted = safeStorage.encryptString(token);
			connections[label].encryptedToken = encrypted.toString('base64');
		}
		
		store.set('connections', connections);
		return { success: true };
	});

	ipcMain.handle('load-connections', () => {
		const connections = (store.get('connections', {}) as any) || {};
		
		// Return list of connection labels
		return Object.keys(connections);
	});

	ipcMain.handle('load-connection', (_event, label) => {
		const connections = (store.get('connections', {}) as any) || {};
		const connection = connections[label];
		
		if (!connection) {
			return null;
		}
		
		let token = '';
		if (connection.encryptedToken && safeStorage.isEncryptionAvailable()) {
			try {
				const buffer = Buffer.from(connection.encryptedToken, 'base64');
				token = safeStorage.decryptString(buffer);
			} catch (error) {
				console.error('Failed to decrypt token:', error);
			}
		}
		
		return {
			serviceUrl: connection.serviceUrl,
			topic: connection.topic,
			subscription: connection.subscription,
			subscriptionType: connection.subscriptionType,
			token,
		};
	});

	ipcMain.handle('delete-connection', (_event, label) => {
		const connections = (store.get('connections', {}) as any) || {};
		delete connections[label];
		store.set('connections', connections);
		return { success: true };
	});

	// Legacy support - old single credential methods
	ipcMain.handle('save-credentials', (_event, credentials) => {
		return ipcMain.emit('save-connection', _event, 'default', credentials);
	});

	ipcMain.handle('load-credentials', () => {
		const connections = (store.get('connections', {}) as any) || {};
		if (connections['default']) {
			return ipcMain.emit('load-connection', null, 'default');
		}
		return {};
	});

	ipcMain.handle('clear-credentials', () => {
		store.delete('connections');
		return { success: true };
	});

	// Manual update check handler
	ipcMain.handle('check-for-updates', async () => {
		if (!app.isPackaged) {
			return { available: false, message: 'Updates only available in production builds' };
		}
		try {
			const result = await autoUpdater.checkForUpdates();
			return { available: true, updateInfo: result?.updateInfo };
		} catch (error: any) {
			console.error('Update check failed:', error);
			return { available: false, error: error.message };
		}
	});

	// Start Express server
	server = expressApp.listen(3000, () => {
		console.log('Express server running on http://localhost:3000');
	});

	// Create window after server is ready
	setTimeout(() => {
		createWindow();
		
		// Check for updates after window is created
		if (app.isPackaged) {
			setTimeout(() => {
				console.log('Starting initial update check...');
				autoUpdater.checkForUpdates().catch(err => {
					console.error('Failed to check for updates:', err);
				});
			}, 3000);
			
			// Check for updates every 4 hours
			setInterval(() => {
				console.log('Performing periodic update check...');
				autoUpdater.checkForUpdates().catch(err => {
					console.error('Failed to check for updates:', err);
				});
			}, 4 * 60 * 60 * 1000);
		} else {
			console.log('Update checks disabled in development mode');
		}
	}, 500);
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', () => {
	if (mainWindow === null) {
		createWindow();
	}
});

// Graceful shutdown
const shutdown = (signal: string) => {
	console.log(`Received ${signal}, starting graceful shutdown...`);

	if (mainWindow) {
		mainWindow.destroy();
	}

	if (server) {
		server.close(() => {
			console.log('Server closed');
			process.exit(0);
		});
	} else {
		process.exit(0);
	}
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
