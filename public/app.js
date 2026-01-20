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
  const initialPositionEl = document.getElementById('initialPosition');
  const messagesEl = document.getElementById('messages');
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
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
  const collapseBtn = document.getElementById('collapseBtn');
  const expandBtn = document.getElementById('expandBtn');
  // Create floating expander overlay to keep expand button clickable above layouts
  let expanderContainer = null;
  if (expandBtn) {
    expanderContainer = document.createElement('div');
    expanderContainer.id = 'connect-expander';
    document.body.appendChild(expanderContainer);
    // Move expand button to the overlay container so it is outside the controls stacking context
    expanderContainer.appendChild(expandBtn);
  }

  let evtSource = null;
  let connectionId = null; // Unique connection ID from backend
  let initialPageLoaded = false; // Track if initial page has been loaded after connection
  
  // Pagination setup
  const MESSAGES_PER_PAGE = 100; // Per-page limit
  let currentPage = 0; // 0-indexed
  let totalBackendMessages = 0; // Track backend total
  let previousBackendCount = 0; // Track previous count to detect new messages
  
  // Cache for syntax highlighting to avoid re-parsing
  const highlightCache = new Map();
  const MAX_CACHE_SIZE = 1000;
  
  // Debounce for page reload on new messages
  let pageRefreshTimer = null;
  let pendingPageRefresh = false;
  
  let currentFilterValue = '';
  let currentUseRegex = false;
  let isSearchActive = false; // Track if a search is currently active

  const counterEl = document.createElement('div');
  counterEl.id = 'counter';
  counterEl.textContent = '0 messages';
  document.getElementById('messages').before(counterEl);

  const paginationEl = document.createElement('div');
  paginationEl.id = 'pagination';
  paginationEl.style.cssText = 'padding: 0.5rem; text-align: center; display: none; gap: 0.5rem;';
  paginationEl.innerHTML = `
    <button id="page-prev" style="padding: 0.4rem 0.8rem; cursor: pointer;">← Previous</button>
    <span id="page-info" style="margin: 0 1rem;">Page 1 of 1</span>
    <button id="page-next" style="padding: 0.4rem 0.8rem; cursor: pointer;">Next →</button>
  `;
  document.getElementById('messages').before(paginationEl);

  const statsEl = document.createElement('div');
  statsEl.id = 'stats';
  statsEl.style.cssText = 'padding: 0.5rem; background: #f5f5f5; border-radius: 4px; font-size: 0.9rem; color: #666; margin-bottom: 1rem; display: none;';
  statsEl.innerHTML = '<strong>Backend:</strong> <span id="stats-messages">0</span> messages | <span id="stats-size">0 MB</span> | Status: <span id="stats-buffering">buffering...</span>';
  document.getElementById('messages').before(statsEl);

  async function fetchAndRenderPage(page = 0) {
    isSearchActive = false; // Reset search state when fetching normal messages
    
    try {
      const response = await fetch(`/api/messages?page=${page}&pageSize=${MESSAGES_PER_PAGE}`);
      if (!response.ok) {
        throw new Error('Failed to fetch messages');
      }
      
      const data = await response.json();
      currentPage = data.page;
      // Don't update totalBackendMessages here - keep the real-time value from SSE stats
      // totalBackendMessages is maintained by the stats event stream
      
      // Batch DOM operations to reduce reflows
      const fragment = document.createDocumentFragment();
      
      data.messages.forEach(msg => {
        const container = document.createElement('div');
        container.className = 'msg message';

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.innerHTML = `<span>✅</span><span>[${new Date().toLocaleTimeString()}] MESSAGE</span>`;

        const pre = document.createElement('pre');
        pre.className = 'payload';
        pre.innerHTML = typeof msg === 'string' ? syntaxHighlight(msg) : syntaxHighlight(JSON.stringify(msg, null, 2));

        container.appendChild(meta);
        container.appendChild(pre);
        fragment.appendChild(container);
      });
      
      // Clear and append in one operation
      messagesEl.innerHTML = '';
      messagesEl.appendChild(fragment);
      
      // Update counters and pagination
      counterEl.textContent = `Page ${currentPage + 1}: ${data.currentPageMessages} messages | Total: ${totalBackendMessages}`;
      // Calculate total pages from real-time backend message count
      const totalPages = Math.ceil(totalBackendMessages / MESSAGES_PER_PAGE);
      updatePagination(totalPages);
      
    } catch (e) {
      addMessage('error', `Failed to load page ${page}: ${e.message}`);
    }
  }

  async function performSearch(query, isRegex, page = 0) {
    if (!query.trim()) {
      // Clear search, go back to normal pagination
      isSearchActive = false;
      fetchAndRenderPage(0);
      return;
    }

    try {
      const searchParams = new URLSearchParams();
      searchParams.append('q', query);
      if (isRegex) {
        searchParams.append('regex', 'true');
      }
      searchParams.append('pageSize', MESSAGES_PER_PAGE);
      searchParams.append('page', page);

      const url = `/api/search?${searchParams.toString()}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Search failed');
      }

      const data = await response.json();
      currentPage = page; // Set to requested page
      totalBackendMessages = data.totalMessages; // Total matches
      isSearchActive = true; // Mark search as active

      // Batch DOM operations to reduce reflows
      const fragment = document.createDocumentFragment();

      data.messages.forEach(msg => {
        const container = document.createElement('div');
        container.className = 'msg message';

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.innerHTML = `<span>✅</span><span>[${new Date().toLocaleTimeString()}] MATCH</span>`;

        const pre = document.createElement('pre');
        pre.className = 'payload';
        pre.innerHTML = typeof msg === 'string' ? syntaxHighlight(msg) : syntaxHighlight(JSON.stringify(msg, null, 2));

        container.appendChild(meta);
        container.appendChild(pre);
        fragment.appendChild(container);
      });

      // Clear and append in one operation
      messagesEl.innerHTML = '';
      messagesEl.appendChild(fragment);

      // Update counters and pagination
      counterEl.textContent = `Search results: (showing page ${currentPage + 1} of ${data.totalPages}) | Matches: ${data.totalMessages}`;
      updatePagination(data.totalPages);

    } catch (e) {
      addMessage('error', `Search failed: ${e.message}`);
    }
  }

  function updatePagination(totalPages) {
    const pageInfo = document.getElementById('page-info');
    pageInfo.textContent = `Page ${currentPage + 1} of ${totalPages}`;
    
    document.getElementById('page-prev').disabled = currentPage === 0;
    document.getElementById('page-next').disabled = currentPage >= totalPages - 1;
    
    paginationEl.style.display = totalBackendMessages > 0 ? 'flex' : 'none';
  }

  function syntaxHighlight(jsonStr) {
    // Check cache first
    if (highlightCache.has(jsonStr)) {
      return highlightCache.get(jsonStr);
    }
    
    const result = jsonStr.replace(/\"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*\"(?=:)/g, m => `<span class="key">${m}</span>`) // keys
      .replace(/:\s*\"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*\"/g, m => m.replace(/\"([^\"]*)\"$/, v => v.replace(/\"/g, '"'))) // keep values
    
    // Cache with LRU eviction
    if (highlightCache.size >= MAX_CACHE_SIZE) {
      const firstKey = highlightCache.keys().next().value;
      highlightCache.delete(firstKey);
    }
    highlightCache.set(jsonStr, result);
    
    return result;
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
  }

  function connect() {
    if (evtSource) return;
    
    const serviceUrl = serviceUrlEl.value.trim();
    const topic = topicEl.value.trim();
    const subscription = subscriptionEl.value.trim();
    const subscriptionType = subscriptionTypeEl.value;
    const initialPosition = initialPositionEl.value;
    const token = tokenEl.value.trim();

    if (!serviceUrl || !topic) {
      addMessage('error', 'Service URL and Topic are required', true);
      return;
    }

    // Update arrow buttons to connected state
    if (collapseBtn) {
      collapseBtn.classList.remove('disconnected');
      collapseBtn.classList.add('connected');
    }
    if (expandBtn) {
      expandBtn.classList.remove('disconnected');
      expandBtn.classList.add('connected');
    }

    // Auto-minimize form after connection established
    setTimeout(() => {
      if (form) {
        updateFormHeightVariable();
        form.classList.add('minimized');
        document.body.classList.add('form-minimized');
      }
      // Show connection established toast
      addMessage('success', '✅ Connection established', true);
    }, 1000);

    addMessage('info', 'Opening stream...', true);
    
    // Build query string with parameters
    const params = new URLSearchParams();
    params.append('serviceUrl', serviceUrl);
    params.append('topic', topic);
    params.append('subscription', subscription);
    params.append('subscriptionType', subscriptionType);
    params.append('initialPosition', initialPosition);
    if (token) {
      params.append('token', token);
    }
    
    // Use GET request with query parameters (SSE streaming)
    fetch(`/api/stream?${params.toString()}`)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: Failed to establish stream`);
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = ''; // Buffer for incomplete SSE messages
        
        function processStream() {
          reader.read().then(({ done, value }) => {
            if (done) {
              disconnect();
              return;
            }
            
            // Add new chunk to buffer
            buffer += decoder.decode(value, { stream: true });
            
            // Split by double newline to get complete SSE messages
            const messages = buffer.split('\n\n');
            
            // Last item may be incomplete, keep it in buffer
            buffer = messages.pop() || '';
            
            // Process complete messages
            messages.forEach(messageBlock => {
              if (!messageBlock.trim()) return;
              
              let eventType = 'message'; // default event type
              let eventData = null;
              
              // Parse event block
              const lines = messageBlock.split('\n');
              lines.forEach(line => {
                if (line.startsWith('event: ')) {
                  eventType = line.substring(7).trim();
                } else if (line.startsWith('data: ')) {
                  try {
                    eventData = JSON.parse(line.substring(6));
                  } catch (err) {
                    console.error('Failed to parse SSE data:', line, err);
                  }
                }
              });
              
              // Handle event data
              if (eventData) {
                try {
                  if (eventType === 'error') {
                    addMessage('error', eventData.error || eventData, true);
                  } else if (eventType === 'info') {
                    // Capture connection ID from info message
                    if (eventData.connectionId && !connectionId) {
                      connectionId = eventData.connectionId;
                      initialPageLoaded = false; // Reset for new connection
                    }
                    addMessage('info', eventData.message || eventData, true);
                  } else if (eventType === 'stats') {
                    // Update backend stats display from SSE stats events (already throttled to 2 sec)
                    statsEl.style.display = 'block';
                    const newCount = eventData.totalMessages;
                    const bufferingStatus = eventData.isBuffering ? 'buffering...' : 'paused';
                    
                    // Load initial page on first stats event after connection
                    // But skip if search is active to preserve search results
                    if (!initialPageLoaded && newCount > 0 && !isSearchActive) {
                      fetchAndRenderPage(0);
                      initialPageLoaded = true;
                    }
                    
                    // Check if stream is being closed
                    if (eventData.streamClosed) {
                      addMessage('info', `Stream closed gracefully. Final message count: ${newCount}`, true);
                      disconnect();
                      return;
                    }
                    
                    // Auto-refresh current page when new messages arrive (debounced)
                    // Skip auto-refresh if:
                    // 1. A search is active (to prevent overwriting search results)
                    // 2. We're on page 0 (initial page never changes as new messages append to the end)
                    const isInitialPage = currentPage === 0;
                    if (newCount > previousBackendCount && connectionId && !isSearchActive && !isInitialPage) {
                      pendingPageRefresh = true;
                      
                      if (pageRefreshTimer) clearTimeout(pageRefreshTimer);
                      pageRefreshTimer = setTimeout(() => {
                        if (pendingPageRefresh) {
                          fetchAndRenderPage(currentPage);
                          pendingPageRefresh = false;
                        }
                      }, 500); // Debounce to 500ms
                    }
                    
                    // Don't update totalBackendMessages while search is active
                    // The search has its own match count from the search API
                    if (!isSearchActive) {
                      totalBackendMessages = newCount;
                      previousBackendCount = newCount;
                      
                      // Update counter to reflect current page and total messages
                      const messagesOnCurrentPage = messagesEl.children.length;
                      counterEl.textContent = `Page ${currentPage + 1}: ${messagesOnCurrentPage} messages | Total: ${totalBackendMessages}`;
                    }
                    
                    if (document.getElementById('stats-messages')) {
                      document.getElementById('stats-messages').textContent = newCount.toLocaleString();
                      document.getElementById('stats-size').textContent = eventData.totalSizeMB.toFixed(2) + ' MB';
                      document.getElementById('stats-buffering').textContent = bufferingStatus;
                    }
                  } else if (eventType === 'batch') {
                    // Backend no longer sends messages - this event is unused
                  } else if (eventType === 'message') {
                    // Backend no longer sends messages - this event is unused
                  }
                } catch (err) {
                  console.error('Error processing SSE event:', err);
                }
              }
            });
            
            processStream();
          }).catch(error => {
            console.error('Stream reading error:', error);
            addMessage('error', 'Stream connection lost. Attempting to reconnect...', true);
            disconnect(false); // Auto-reconnect (not user disconnect)
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
        disconnect(false); // Auto-reconnect (not user disconnect)
      });

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  }

  function disconnect(userInitiated = true) {
    if (evtSource) {
      evtSource.close();
      evtSource = null;
      connectionId = null;
      initialPageLoaded = false; // Reset for next connection
      if (userInitiated) {
        addMessage('info', 'Disconnected', true);
      }
    }
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    
    // Update arrow buttons to disconnected state
    if (collapseBtn) {
      collapseBtn.classList.remove('connected');
      collapseBtn.classList.add('disconnected');
    }
    if (expandBtn) {
      expandBtn.classList.remove('connected');
      expandBtn.classList.add('disconnected');
    }
    
    // Only expand form if user manually disconnected
    if (userInitiated && form) {
      form.classList.remove('minimized');
      document.body.classList.remove('form-minimized');
    }
    
    // Show connection dropped toast
    if (userInitiated) {
      addMessage('info', '🔌 Disconnected', true);
    } else {
      addMessage('warning', '⚠️ Connection dropped', true);
    }
    
    // Auto-reconnect if not user-initiated disconnect
    if (!userInitiated) {
      setTimeout(() => {
        if (!evtSource) { // Only reconnect if still disconnected
          addMessage('info', 'Reconnecting...', true);
          connect();
        }
      }, 2000); // Wait 2 seconds before reconnecting
    }
  }


  // Refresh the message view with current filter
  function refreshMessageView() {
    if (!connectionId) return;
    currentPage = 0; // Reset to first page
    fetchAndRenderPage(0);
  }

  // Watch for filter changes - trigger server-side search
  if (filterEl) {
    let searchTimer = null;
    filterEl.addEventListener('input', () => {
      const query = filterEl.value.trim();
      
      // Debounce search input
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (query) {
          performSearch(query, useRegexEl.checked);
        } else {
          // Clear search, go back to normal pagination
          fetchAndRenderPage(0);
        }
      }, 300);
    });
  }

  // Watch for regex toggle changes
  if (useRegexEl) {
    useRegexEl.addEventListener('change', () => {
      currentUseRegex = useRegexEl.checked;
      // If there's a search query, re-search with new regex setting
      const query = filterEl.value.trim();
      if (query) {
        performSearch(query, currentUseRegex);
      } else {
        refreshMessageView();
      }
    });
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    connect();
  });
  disconnectBtn.addEventListener('click', () => disconnect(true));

  // Helper function to set form height CSS variable
  function updateFormHeightVariable() {
    if (form) {
      const height = form.offsetHeight;
      document.documentElement.style.setProperty('--connect-form-height', `${height}px`);
    }
  }

  // Update height variable on load and resize
  updateFormHeightVariable();
  window.addEventListener('resize', updateFormHeightVariable);

  // Collapse/Expand Connect Form
  if (collapseBtn) {
    collapseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      updateFormHeightVariable();
      form.classList.add('minimized');
      document.body.classList.add('form-minimized');
    });
  }

  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      form.classList.remove('minimized');
      document.body.classList.remove('form-minimized');
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
          initialPositionEl.value = connection.initialPosition || 'latest';
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
          initialPosition: initialPositionEl.value,
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

  // Pagination controls
  if (document.getElementById('page-prev')) {
    document.getElementById('page-prev').addEventListener('click', () => {
      if (currentPage > 0) {
        if (isSearchActive) {
          // Paginate through search results
          const query = filterEl.value.trim();
          performSearch(query, useRegexEl.checked, currentPage - 1);
        } else {
          // Normal pagination
          fetchAndRenderPage(currentPage - 1);
        }
        window.scrollTo(0, 0);
      }
    });
  }

  if (document.getElementById('page-next')) {
    document.getElementById('page-next').addEventListener('click', async () => {
      if (isSearchActive) {
        // For search results, paginate through search
        const query = filterEl.value.trim();
        // Get total pages from current search state
        const totalPages = Math.ceil(totalBackendMessages / MESSAGES_PER_PAGE);
        if (currentPage < totalPages - 1) {
          performSearch(query, useRegexEl.checked, currentPage + 1);
          window.scrollTo(0, 0);
        }
      } else {
        // Normal pagination with total messages
        const totalPages = Math.ceil(totalBackendMessages / MESSAGES_PER_PAGE);
        if (currentPage < totalPages - 1) {
          fetchAndRenderPage(currentPage + 1);
          window.scrollTo(0, 0);
        }
      }
    });
  }
})();
