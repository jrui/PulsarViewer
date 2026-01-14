(() => {
  // Storage utilities - use Electron if available, otherwise localStorage
  const storage = {
    isElectron: window.electron && window.electron.saveConnection,
    
    async saveConnection(label, credentials) {
      if (this.isElectron) {
        return window.electron.saveConnection(label, credentials);
      } else {
        const connections = JSON.parse(localStorage.getItem('pulsarConnections') || '{}');
        connections[label] = credentials;
        localStorage.setItem('pulsarConnections', JSON.stringify(connections));
        return { success: true };
      }
    },
    
    async loadConnections() {
      if (this.isElectron) {
        return window.electron.loadConnections();
      } else {
        const connections = JSON.parse(localStorage.getItem('pulsarConnections') || '{}');
        return Object.keys(connections);
      }
    },
    
    async loadConnection(label) {
      if (this.isElectron) {
        return window.electron.loadConnection(label);
      } else {
        const connections = JSON.parse(localStorage.getItem('pulsarConnections') || '{}');
        return connections[label] || null;
      }
    },
    
    async deleteConnection(label) {
      if (this.isElectron) {
        return window.electron.deleteConnection(label);
      } else {
        const connections = JSON.parse(localStorage.getItem('pulsarConnections') || '{}');
        delete connections[label];
        localStorage.setItem('pulsarConnections', JSON.stringify(connections));
        return { success: true };
      }
    },
  };

  // Handle splash screen animation completion
  document.addEventListener('DOMContentLoaded', async () => {
    // Wait for animation to complete (3.5s total: 3s animation + 1.5s delay for fade)
    setTimeout(() => {
      document.body.style.overflow = 'auto';
    }, 4500);
    
    // Load saved connections
    try {
      const connectionLabels = await storage.loadConnections();
      const savedConnectionsEl = document.getElementById('savedConnections');
      
      if (savedConnectionsEl && connectionLabels.length > 0) {
        // Clear existing options except the first one
        savedConnectionsEl.innerHTML = '<option value="">-- Select a saved connection --</option>';
        
        // Add saved connections to dropdown
        connectionLabels.forEach(label => {
          const option = document.createElement('option');
          option.value = label;
          option.textContent = label;
          savedConnectionsEl.appendChild(option);
        });
      }
    } catch (error) {
      console.error('Failed to load saved connections:', error);
    }
  });

  const form = document.getElementById('connect-form');
  const serviceUrlEl = document.getElementById('serviceUrl');
  const topicEl = document.getElementById('topic');
  const tokenEl = document.getElementById('token');
  const subscriptionEl = document.getElementById('subscription');
  const subscriptionTypeEl = document.getElementById('subscriptionType');
  const messagesEl = document.getElementById('messages');
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const clearBtn = document.getElementById('clearBtn');
  const autoScrollEl = document.getElementById('autoScroll');
  const pauseBtn = document.getElementById('pauseBtn');
  const filterEl = document.getElementById('filter');
  const useRegexEl = document.getElementById('useRegex');
  const savedConnectionsEl = document.getElementById('savedConnections');
  const loadConnectionBtn = document.getElementById('loadConnectionBtn');
  const deleteConnectionBtn = document.getElementById('deleteConnectionBtn');
  const saveConnectionBtn = document.getElementById('saveConnectionBtn');
  const connectionLabelEl = document.getElementById('connectionLabel');
  const labelModal = document.getElementById('labelModal');
  const labelModalInput = document.getElementById('labelModalInput');
  const labelModalSave = document.getElementById('labelModalSave');
  const labelModalCancel = document.getElementById('labelModalCancel');

  let evtSource = null;
  let isPaused = false;
  let allMessages = []; // Store all messages received from backend
  let currentFilterValue = '';
  let currentUseRegex = false;

  const counterEl = document.createElement('div');
  counterEl.id = 'counter';
  counterEl.textContent = '0 messages';
  document.getElementById('messages').before(counterEl);
  let count = 0;

  function syntaxHighlight(jsonStr) {
    return jsonStr.replace(/\"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*\"(?=:)/g, m => `<span class="key">${m}</span>`) // keys
      .replace(/:\s*\"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*\"/g, m => m.replace(/\"([^\"]*)\"$/, v => v.replace(/\"/g, '"'))) // keep values
  }

  // Check if a message matches the current filter
  function matchesFilter(payload) {
    const filterValue = currentFilterValue.trim();
    if (!filterValue) return true; // No filter, show all

    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    
    if (currentUseRegex) {
      try {
        const regex = new RegExp(filterValue);
        return regex.test(payloadStr);
      } catch (e) {
        // Invalid regex, fallback to substring match
        return payloadStr.includes(filterValue);
      }
    } else {
      return payloadStr.includes(filterValue);
    }
  }

  function addMessage(kind, payload, skipFilter = false) {
    if (isPaused) return;
    
    // Apply filter only to 'message' kind, not to info/error messages
    if (kind === 'message' && !skipFilter && !matchesFilter(payload)) {
      return; // Don't display message if it doesn't match filter
    }

    const container = document.createElement('div');
    container.className = 'msg ' + kind;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const icons = { info: '💡', error: '❌', message: '✅' };
    meta.innerHTML = `<span>${icons[kind] || '📋'}</span><span>[${new Date().toLocaleTimeString()}] ${kind.toUpperCase()}</span>`;

    const pre = document.createElement('pre');
    pre.className = 'payload';
    pre.innerHTML = typeof payload === 'string' ? syntaxHighlight(payload) : syntaxHighlight(JSON.stringify(payload, null, 2));

    container.appendChild(meta);
    container.appendChild(pre);
    messagesEl.appendChild(container);

    count++;
    counterEl.textContent = `${count} message${count !== 1 ? 's' : ''}`;

    if (autoScrollEl.checked) {
      container.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }

  function connect() {
    if (evtSource) return;
    
    const payload = {
      serviceUrl: serviceUrlEl.value.trim(),
      topic: topicEl.value.trim(),
      subscription: subscriptionEl.value.trim(),
      subscriptionType: subscriptionTypeEl.value,
      token: tokenEl.value.trim() || undefined,
    };

    addMessage('info', 'Opening stream...', true);
    
    // Use fetch to POST the connection request
    fetch('/api/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }).then(response => {
      if (!response.ok) {
        throw new Error('Failed to establish stream');
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      function processStream() {
        reader.read().then(({ done, value }) => {
          if (done) {
            disconnect();
            return;
          }
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n\n');
          
          lines.forEach(line => {
            if (line.startsWith('data: ')) {
              try {
                const msgData = JSON.parse(line.substring(6));
                if (msgData.error) {
                  addMessage('error', msgData.error, true);
                } else {
                  allMessages.push(msgData);
                  addMessage('message', msgData);
                }
              } catch (err) {
                console.error('Failed to parse SSE data:', err);
              }
            }
          });
          
          processStream();
        }).catch(error => {
          console.error('Stream reading error:', error);
          addMessage('error', 'Stream connection lost', true);
          disconnect();
        });
      }
      
      processStream();
      
      // Create a pseudo EventSource object for compatibility
      evtSource = {
        close: () => {
          reader.cancel();
          evtSource = null;
        }
      };
      
    }).catch(error => {
      addMessage('error', error.message, true);
      disconnect();
    });

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  }

  function disconnect() {
    if (evtSource) {
      evtSource.close();
      evtSource = null;
      addMessage('info', 'Disconnected', true);
      allMessages = []; // Clear stored messages on disconnect
    }
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }

  function clearMessages() {
    messagesEl.innerHTML = '';
    allMessages = []; // Clear stored messages
    count = 0;
    counterEl.textContent = '';
  }

  // Refresh the message view with current filter
  // Note: For large message volumes, this could be optimized by showing/hiding
  // existing DOM elements instead of recreating them
  function refreshMessageView() {
    // Save scroll position
    const scrollTop = messagesEl.parentElement ? messagesEl.parentElement.scrollTop : 0;
    
    // Clear displayed messages
    messagesEl.innerHTML = '';
    count = 0;
    counterEl.textContent = '';
    
    // Re-display all messages with current filter
    allMessages.forEach(msg => {
      addMessage('message', msg);
    });
    
    // Update counter after all messages are processed
    counterEl.textContent = `${count} message${count !== 1 ? 's' : ''}`;
    
    // Restore scroll position if not auto-scrolling
    if (!autoScrollEl.checked && messagesEl.parentElement) {
      messagesEl.parentElement.scrollTop = scrollTop;
    }
  }

  // Watch for filter changes
  if (filterEl) {
    filterEl.addEventListener('input', () => {
      currentFilterValue = filterEl.value;
      refreshMessageView();
    });
  }

  // Watch for regex toggle changes
  if (useRegexEl) {
    useRegexEl.addEventListener('change', () => {
      currentUseRegex = useRegexEl.checked;
      refreshMessageView();
    });
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    connect();
  });
  disconnectBtn.addEventListener('click', disconnect);
  clearBtn.addEventListener('click', clearMessages);

  // Pause/Unpause button
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
      pauseBtn.style.backgroundColor = isPaused ? 'var(--color-warning)' : '';
    });
  }

  // Auto-load connection when selected from dropdown
  if (savedConnectionsEl) {
    savedConnectionsEl.addEventListener('change', async () => {
      const selectedLabel = savedConnectionsEl.value;
      if (!selectedLabel) {
        return;
      }
      
      try {
        const connection = await storage.loadConnection(selectedLabel);
        if (connection) {
          serviceUrlEl.value = connection.serviceUrl || '';
          topicEl.value = connection.topic || '';
          subscriptionEl.value = connection.subscription || 'viewer-sub';
          subscriptionTypeEl.value = connection.subscriptionType || 'Exclusive';
          tokenEl.value = connection.token || '';
        }
      } catch (err) {
        console.error('Failed to load connection:', err);
        alert('Failed to load connection');
      }
    });
  }

  // Connection management
  if (saveConnectionBtn) {
    saveConnectionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      labelModal.style.display = 'flex';
      labelModalInput.value = '';
      labelModalInput.focus();
    });
  }

  if (labelModalCancel) {
    labelModalCancel.addEventListener('click', () => {
      labelModal.style.display = 'none';
    });
  }

  if (labelModalSave) {
    labelModalSave.addEventListener('click', async () => {
      const label = labelModalInput.value.trim();
      if (!label) {
        alert('Please enter a name for this connection');
        return;
      }
      
      try {
        await storage.saveConnection(label, {
          serviceUrl: serviceUrlEl.value.trim(),
          topic: topicEl.value.trim(),
          subscription: subscriptionEl.value.trim(),
          subscriptionType: subscriptionTypeEl.value,
          token: tokenEl.value.trim(),
        });
        
        // Refresh the connections dropdown
        const connectionLabels = await storage.loadConnections();
        savedConnectionsEl.innerHTML = '<option value="">-- Select a saved connection --</option>';
        connectionLabels.forEach(l => {
          const option = document.createElement('option');
          option.value = l;
          option.textContent = l;
          savedConnectionsEl.appendChild(option);
        });
        
        // Select the newly saved connection
        savedConnectionsEl.value = label;
        labelModal.style.display = 'none';
      } catch (err) {
        console.error('Failed to save connection:', err);
        alert('Failed to save connection');
      }
    });
  }

  // Allow Enter key to save in modal
  if (labelModalInput) {
    labelModalInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        labelModalSave.click();
      }
    });
  }

  if (deleteConnectionBtn) {
    deleteConnectionBtn.addEventListener('click', async () => {
      const selectedLabel = savedConnectionsEl.value;
      if (!selectedLabel) {
        alert('Please select a connection to delete');
        return;
      }
      
      if (!confirm(`Are you sure you want to delete the connection "${selectedLabel}"?`)) {
        return;
      }
      
      try {
        await storage.deleteConnection(selectedLabel);
        
        // Refresh the connections dropdown
        const connectionLabels = await storage.loadConnections();
        savedConnectionsEl.innerHTML = '<option value="">-- Select a saved connection --</option>';
        connectionLabels.forEach(l => {
          const option = document.createElement('option');
          option.value = l;
          option.textContent = l;
          savedConnectionsEl.appendChild(option);
        });
        
      } catch (err) {
        console.error('Failed to delete connection:', err);
        alert('Failed to delete connection');
      }
    });
  }

  // Send message form logic
  const sendForm = document.getElementById('send-form');
  const sendBtn = document.getElementById('sendBtn');
  sendForm.addEventListener('submit', async e => {
    e.preventDefault();
    sendBtn.disabled = true;
    const serviceUrl = serviceUrlEl.value.trim();
    const topic = topicEl.value.trim();
    const token = tokenEl.value.trim();
    const payload = document.getElementById('sendPayload').value;
    const key = document.getElementById('sendKey').value.trim();
    const propsRaw = document.getElementById('sendProps').value.trim();
    let properties = undefined;
    if (propsRaw) {
      try { properties = JSON.parse(propsRaw); } catch { addMessage('error', 'Properties JSON invalid'); sendBtn.disabled = false; return; }
    }
    try {
      const resp = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceUrl, topic, payload, key, properties, token })
      });
      const result = await resp.json();
      if (resp.ok) {
        addMessage('info', `Sent! MessageId: ${result.messageId}`);
      } else {
        addMessage('error', result.error || 'Send failed');
      }
    } catch (err) {
      addMessage('error', String(err));
    }
    sendBtn.disabled = false;
  });
})();
