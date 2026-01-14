import { contextBridge, ipcRenderer } from 'electron';

// Expose safe APIs to the renderer process
contextBridge.exposeInMainWorld('electron', {
	nodeVersion: () => process.versions.node,
	chromeVersion: () => process.versions.chrome,
	electronVersion: () => process.versions.electron,
	
	// Connection management
	saveConnection: (label: string, credentials: any) => ipcRenderer.invoke('save-connection', label, credentials),
	loadConnections: () => ipcRenderer.invoke('load-connections'),
	loadConnection: (label: string) => ipcRenderer.invoke('load-connection', label),
	deleteConnection: (label: string) => ipcRenderer.invoke('delete-connection', label),
	
	// Legacy credentials management
	saveCredentials: (credentials: any) => ipcRenderer.invoke('save-credentials', credentials),
	loadCredentials: () => ipcRenderer.invoke('load-credentials'),
	clearCredentials: () => ipcRenderer.invoke('clear-credentials'),
});
