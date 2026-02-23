(() => {
  // In Tauri desktop app, frontend is served by the app; API runs on localhost:3000
  const API_BASE = (typeof window !== 'undefined' && window.__TAURI__) ? 'http://localhost:3000' : '';

  // ─── Storage ────────────────────────────────────────────────────────────────
  const storage = {
    isElectron: !!(window.electron && window.electron.saveConnection),
    async saveConnection(label, data) {
      if (this.isElectron) return window.electron.saveConnection(label, data);
      const c = JSON.parse(localStorage.getItem('pulsarConnections') || '{}');
      c[label] = data;
      localStorage.setItem('pulsarConnections', JSON.stringify(c));
      return { success: true };
    },
    async loadConnections() {
      if (this.isElectron) return window.electron.loadConnections();
      return Object.keys(JSON.parse(localStorage.getItem('pulsarConnections') || '{}'));
    },
    async loadConnection(label) {
      if (this.isElectron) return window.electron.loadConnection(label);
      return JSON.parse(localStorage.getItem('pulsarConnections') || '{}')[label] || null;
    },
    async deleteConnection(label) {
      if (this.isElectron) return window.electron.deleteConnection(label);
      const c = JSON.parse(localStorage.getItem('pulsarConnections') || '{}');
      delete c[label];
      localStorage.setItem('pulsarConnections', JSON.stringify(c));
      return { success: true };
    },
  };

  // ─── State ──────────────────────────────────────────────────────────────────
  let activeTab = 'consumer';
  let isConnected = false;
  let evtSource = null;
  let connectionId = null;
  let initialPageLoaded = false;
  let currentPage = 0;
  let totalBackendMessages = 0;
  let previousBackendCount = 0;
  let isSearchActive = false;
  let pageRefreshTimer = null;
  let pendingPageRefresh = false;
  let currentFilterValue = '';
  let currentUseRegex = false;
  let selectedConnectionLabel = null;
  let selectedTopic = null; // for management tab

  const MESSAGES_PER_PAGE = 100;
  const highlightCache = new Map();
  const MAX_CACHE_SIZE = 1000;

  // ─── DOM refs ────────────────────────────────────────────────────────────────
  const serviceUrlEl    = document.getElementById('serviceUrl');
  const topicEl         = document.getElementById('topic');
  const tokenEl         = document.getElementById('token');
  const subscriptionEl  = document.getElementById('subscription');
  const subTypeEl       = document.getElementById('subscriptionType');
  const initialPosEl    = document.getElementById('initialPosition');
  const connectBtn      = document.getElementById('connectBtn');
  const disconnectBtn   = document.getElementById('disconnectBtn');
  const filterEl        = document.getElementById('filter');
  const useRegexEl      = document.getElementById('useRegex');
  const messagesEl      = document.getElementById('messages');
  const counterEl       = document.getElementById('counter');
  const paginationEl    = document.getElementById('pagination');
  const exportCsvBtn    = document.getElementById('exportCsvBtn');
  const clearBtn        = document.getElementById('clearBtn');
  const connectionLabelEl = document.getElementById('connectionLabel');
  const saveConnectionBtn = document.getElementById('saveConnectionBtn');
  const deleteConnectionBtn = document.getElementById('deleteConnectionBtn');
  const savedConnectionsListEl = document.getElementById('saved-connections-list');
  const labelModal      = document.getElementById('labelModal');
  const labelModalInput = document.getElementById('labelModalInput');
  const labelModalSave  = document.getElementById('labelModalSave');
  const labelModalCancel = document.getElementById('labelModalCancel');
  const statusDot       = document.getElementById('status-dot');
  const statusText      = document.getElementById('status-text');
  const tabStatusBadge  = document.getElementById('tab-status-badge');
  const authToast       = document.getElementById('auth-toast');
  const authToastMsg    = document.getElementById('auth-toast-msg');
  const authToastClose  = document.getElementById('auth-toast-close');
  const statsBar        = document.getElementById('consumer-stats-bar');

  // ─── Splash ──────────────────────────────────────────────────────────────────
  // Trigger background colour morph alongside the splash fade-out
  document.body.classList.add('app-ready');
  setTimeout(() => { document.body.style.overflow = 'auto'; }, 4500);

  // ─── Tab switching ───────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === activeTab) return;
      switchTab(tab);
    });
  });

  async function switchTab(tab) {
    // Tear down active consumer/producer when leaving those tabs
    if (activeTab === 'consumer' && evtSource) {
      await serverDisconnect();
    }

    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));

    if (tab === 'management' && isConnected) {
      // Management tab opened — load namespace topics if connected
      loadTopics();
    }
  }

  // ─── Connection status helpers ───────────────────────────────────────────────
  function setConnected(connected) {
    isConnected = connected;
    statusDot.className = connected ? 'dot dot-connected' : 'dot';
    statusText.textContent = connected ? 'Connected' : 'Disconnected';
    tabStatusBadge.textContent = connected ? 'Connected' : 'Disconnected';
    tabStatusBadge.className = connected ? 'badge-connected' : 'badge-disconnected';
    connectBtn.disabled = connected;
    disconnectBtn.disabled = !connected;
  }

  // ─── Auth error toast ────────────────────────────────────────────────────────
  function showAuthError(msg) {
    authToastMsg.textContent = msg || 'Token lacks sufficient permissions for this operation.';
    authToast.style.display = 'flex';
  }

  authToastClose.addEventListener('click', () => { authToast.style.display = 'none'; });

  // ─── Saved connections sidebar ───────────────────────────────────────────────
  async function refreshSavedConnections() {
    const labels = await storage.loadConnections();
    savedConnectionsListEl.innerHTML = '';

    if (labels.length === 0) {
      savedConnectionsListEl.innerHTML = '<div class="conn-empty">No saved connections</div>';
      return;
    }

    labels.forEach(label => {
      const item = document.createElement('div');
      item.className = 'conn-item' + (label === selectedConnectionLabel ? ' active' : '');
      item.dataset.label = label;
      item.innerHTML = `
        <span class="conn-icon">⬡</span>
        <span class="conn-name">${label}</span>
      `;
      item.addEventListener('click', () => loadConnectionIntoForm(label));
      savedConnectionsListEl.appendChild(item);
    });
  }

  async function loadConnectionIntoForm(label) {
    const conn = await storage.loadConnection(label);
    if (!conn) return;
    selectedConnectionLabel = label;
    serviceUrlEl.value    = conn.serviceUrl || '';
    topicEl.value         = conn.topic || '';
    tokenEl.value         = conn.token || '';
    subscriptionEl.value  = conn.subscription || 'viewer-sub';
    subTypeEl.value       = conn.subscriptionType || 'Exclusive';
    initialPosEl.value    = conn.initialPosition || 'latest';
    connectionLabelEl.value = label;
    refreshSavedConnections();
  }

  saveConnectionBtn.addEventListener('click', () => {
    labelModalInput.value = connectionLabelEl.value.trim();
    labelModal.style.display = 'flex';
    labelModalInput.focus();
  });

  labelModalCancel.addEventListener('click', () => { labelModal.style.display = 'none'; });

  labelModalSave.addEventListener('click', async () => {
    const label = labelModalInput.value.trim();
    if (!label) { labelModalInput.focus(); return; }
    await storage.saveConnection(label, {
      serviceUrl:       serviceUrlEl.value.trim(),
      topic:            topicEl.value.trim(),
      token:            tokenEl.value.trim(),
      subscription:     subscriptionEl.value.trim(),
      subscriptionType: subTypeEl.value,
      initialPosition:  initialPosEl.value,
    });
    selectedConnectionLabel = label;
    connectionLabelEl.value = label;
    labelModal.style.display = 'none';
    await refreshSavedConnections();
  });

  labelModalInput.addEventListener('keypress', e => { if (e.key === 'Enter') labelModalSave.click(); });

  deleteConnectionBtn.addEventListener('click', async () => {
    const label = connectionLabelEl.value.trim() || selectedConnectionLabel;
    if (!label) return;
    if (!confirm(`Delete connection "${label}"?`)) return;
    await storage.deleteConnection(label);
    if (selectedConnectionLabel === label) {
      selectedConnectionLabel = null;
      connectionLabelEl.value = '';
    }
    await refreshSavedConnections();
  });

  document.getElementById('newConnectionBtn').addEventListener('click', () => {
    selectedConnectionLabel = null;
    serviceUrlEl.value = '';
    topicEl.value = '';
    tokenEl.value = '';
    subscriptionEl.value = 'viewer-sub';
    subTypeEl.value = 'Exclusive';
    initialPosEl.value = 'latest';
    connectionLabelEl.value = '';
    document.querySelectorAll('.conn-item').forEach(i => i.classList.remove('active'));
  });

  // ─── Connect / Disconnect ─────────────────────────────────────────────────
  connectBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', () => userDisconnect());

  function connect() {
    if (evtSource) return;

    const serviceUrl     = serviceUrlEl.value.trim();
    const topic          = topicEl.value.trim();
    const subscription   = subscriptionEl.value.trim();
    const subscriptionType = subTypeEl.value;
    const initialPosition  = initialPosEl.value;
    const token          = tokenEl.value.trim();

    if (!serviceUrl || !topic) {
      addConsumerMessage('error', 'Service URL and Topic are required.');
      return;
    }

    addConsumerMessage('info', 'Connecting to Pulsar...');

    const params = new URLSearchParams({ serviceUrl, topic, subscription, subscriptionType, initialPosition });
    if (token) params.append('token', token);

    fetch(`${API_BASE}/api/stream?${params}`)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setConnected(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function processStream() {
          reader.read().then(({ done, value }) => {
            if (done) { handleStreamClose(false); return; }
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';

            parts.forEach(block => {
              if (!block.trim()) return;
              let type = 'message', data = null;
              block.split('\n').forEach(line => {
                if (line.startsWith('event: ')) type = line.slice(7).trim();
                else if (line.startsWith('data: ')) {
                  try { data = JSON.parse(line.slice(6)); } catch {}
                }
              });
              if (data) handleSSEEvent(type, data);
            });

            processStream();
          }).catch(() => handleStreamClose(false));
        }

        processStream();

        evtSource = { close: () => { reader.cancel(); evtSource = null; } };
      })
      .catch(err => {
        addConsumerMessage('error', err.message);
        setConnected(false);
      });
  }

  function handleSSEEvent(type, data) {
    if (type === 'error') {
      const msg = data.error || (typeof data === 'string' ? data : JSON.stringify(data));
      addConsumerMessage('error', msg);
      // Detect auth errors
      if (/unauthori[zs]ed|permission|forbidden/i.test(msg)) {
        showAuthError(msg);
      }
    } else if (type === 'info') {
      if (data.connectionId && !connectionId) {
        connectionId = data.connectionId;
        initialPageLoaded = false;
      }
      addConsumerMessage('info', data.message || JSON.stringify(data));
    } else if (type === 'stats') {
      statsBar.style.display = 'flex';
      const newCount = data.totalMessages;

      if (!initialPageLoaded && newCount > 0 && !isSearchActive) {
        fetchAndRenderPage(0);
        initialPageLoaded = true;
      }
      if (data.streamClosed) {
        addConsumerMessage('info', `Stream closed. Final count: ${newCount}`);
        handleStreamClose(true);
        return;
      }
      if (newCount > previousBackendCount && connectionId && !isSearchActive && currentPage !== 0) {
        pendingPageRefresh = true;
        if (pageRefreshTimer) clearTimeout(pageRefreshTimer);
        pageRefreshTimer = setTimeout(() => {
          if (pendingPageRefresh) { fetchAndRenderPage(currentPage); pendingPageRefresh = false; }
        }, 500);
      }
      if (!isSearchActive) {
        totalBackendMessages = newCount;
        previousBackendCount = newCount;
        updateCounterDisplay();
      }
      document.getElementById('stats-messages').textContent = newCount.toLocaleString();
      document.getElementById('stats-size').textContent = (data.totalSizeMB || 0).toFixed(2) + ' MB';
      document.getElementById('stats-buffering').textContent = data.isBuffering ? 'buffering' : 'streaming';
    }
  }

  function handleStreamClose(graceful) {
    if (evtSource) { evtSource.close(); evtSource = null; }
    connectionId = null;
    initialPageLoaded = false;
    if (!graceful) {
      addConsumerMessage('info', 'Stream disconnected.');
      setConnected(false);
    }
  }

  async function userDisconnect() {
    await serverDisconnect();
    addConsumerMessage('info', 'Disconnected.');
    setConnected(false);
    statsBar.style.display = 'none';
  }

  async function serverDisconnect() {
    if (evtSource) { evtSource.close(); evtSource = null; }
    connectionId = null;
    initialPageLoaded = false;
    try { await fetch(`${API_BASE}/api/disconnect`, { method: 'POST' }); } catch {}
    totalBackendMessages = 0;
    previousBackendCount = 0;
    currentPage = 0;
    isSearchActive = false;
  }

  // ─── Consumer messages ────────────────────────────────────────────────────
  function syntaxHighlight(str) {
    if (highlightCache.has(str)) return highlightCache.get(str);
    const result = str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?/g, match => {
        const cls = /:$/.test(match) ? 'json-key' : 'json-str';
        return `<span class="${cls}">${match}</span>`;
      })
      .replace(/\b(true|false)\b/g, '<span class="json-bool">$1</span>')
      .replace(/\b(null)\b/g, '<span class="json-null">$1</span>')
      .replace(/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span class="json-num">$1</span>');
    if (highlightCache.size >= MAX_CACHE_SIZE) {
      highlightCache.delete(highlightCache.keys().next().value);
    }
    highlightCache.set(str, result);
    return result;
  }

  function makeMessageEl(kind, payload, targetEl) {
    targetEl = targetEl || messagesEl;
    const container = document.createElement('div');
    container.className = `msg msg-${kind}`;

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const icons = { info: '●', error: '✕', message: '▶', warning: '▲' };
    meta.innerHTML = `<span class="msg-icon msg-icon-${kind}">${icons[kind] || '·'}</span>
      <span class="msg-time">${new Date().toLocaleTimeString()}</span>
      <span class="msg-type">${kind.toUpperCase()}</span>`;

    const pre = document.createElement('pre');
    pre.className = 'msg-payload';
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    pre.innerHTML = syntaxHighlight(raw);

    container.appendChild(meta);
    container.appendChild(pre);
    return container;
  }

  function addConsumerMessage(kind, payload) {
    messagesEl.appendChild(makeMessageEl(kind, payload));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addProducerMessage(kind, payload) {
    const el = document.getElementById('producer-messages');
    el.appendChild(makeMessageEl(kind, payload, el));
    el.scrollTop = el.scrollHeight;
  }

  // ─── Pagination & fetching ────────────────────────────────────────────────
  async function fetchAndRenderPage(page = 0) {
    isSearchActive = false;
    try {
      const res = await fetch(`${API_BASE}/api/messages?page=${page}&pageSize=${MESSAGES_PER_PAGE}`);
      if (!res.ok) throw new Error('Failed to fetch messages');
      const data = await res.json();
      currentPage = data.page;
      renderMessages(data.messages);
      const totalPages = Math.ceil(totalBackendMessages / MESSAGES_PER_PAGE);
      updatePagination(totalPages);
      updateCounterDisplay();
    } catch (e) {
      addConsumerMessage('error', `Failed to load page ${page}: ${e.message}`);
    }
  }

  async function performSearch(query, isRegex, page = 0) {
    if (!query.trim()) { isSearchActive = false; fetchAndRenderPage(0); return; }
    try {
      const params = new URLSearchParams({ q: query, pageSize: MESSAGES_PER_PAGE, page });
      if (isRegex) params.append('regex', 'true');
      const res = await fetch(`${API_BASE}/api/search?${params}`);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      currentPage = page;
      totalBackendMessages = data.totalMessages;
      isSearchActive = true;
      renderMessages(data.messages);
      counterEl.textContent = `Search: ${data.totalMessages} matches (page ${page + 1} of ${data.totalPages})`;
      counterEl.style.display = 'block';
      updatePagination(data.totalPages);
    } catch (e) {
      addConsumerMessage('error', `Search failed: ${e.message}`);
    }
  }

  function renderMessages(msgs) {
    const fragment = document.createDocumentFragment();
    msgs.forEach(msg => {
      const raw = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
      const container = document.createElement('div');
      container.className = 'msg msg-message';
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = `<span class="msg-icon msg-icon-message">▶</span>
        <span class="msg-time">${msg.publishTime ? new Date(msg.publishTime).toLocaleTimeString() : ''}</span>
        ${msg.key ? `<span class="msg-key">${msg.key}</span>` : ''}`;
      const pre = document.createElement('pre');
      pre.className = 'msg-payload';
      pre.innerHTML = syntaxHighlight(msg.payload || raw);
      container.appendChild(meta);
      container.appendChild(pre);
      fragment.appendChild(container);
    });
    messagesEl.innerHTML = '';
    messagesEl.appendChild(fragment);
  }

  function updateCounterDisplay() {
    if (totalBackendMessages === 0) { counterEl.style.display = 'none'; return; }
    counterEl.style.display = 'block';
    counterEl.textContent = `Page ${currentPage + 1} · ${messagesEl.children.length} shown · ${totalBackendMessages.toLocaleString()} total`;
  }

  function updatePagination(totalPages) {
    document.getElementById('page-info').textContent = `Page ${currentPage + 1} of ${totalPages || 1}`;
    document.getElementById('page-prev').disabled = currentPage === 0;
    document.getElementById('page-next').disabled = currentPage >= (totalPages || 1) - 1;
    paginationEl.style.display = totalBackendMessages > MESSAGES_PER_PAGE ? 'flex' : 'none';
  }

  document.getElementById('page-prev').addEventListener('click', () => {
    if (currentPage > 0) {
      isSearchActive ? performSearch(filterEl.value, useRegexEl.checked, currentPage - 1) : fetchAndRenderPage(currentPage - 1);
    }
  });
  document.getElementById('page-next').addEventListener('click', () => {
    const totalPages = Math.ceil(totalBackendMessages / MESSAGES_PER_PAGE);
    if (currentPage < totalPages - 1) {
      isSearchActive ? performSearch(filterEl.value, useRegexEl.checked, currentPage + 1) : fetchAndRenderPage(currentPage + 1);
    }
  });

  // ─── Filter / search ──────────────────────────────────────────────────────
  let searchTimer = null;
  filterEl.addEventListener('input', () => {
    const q = filterEl.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      q ? performSearch(q, useRegexEl.checked) : fetchAndRenderPage(0);
    }, 300);
  });

  useRegexEl.addEventListener('change', () => {
    const q = filterEl.value.trim();
    q ? performSearch(q, useRegexEl.checked) : fetchAndRenderPage(0);
  });

  // ─── Export CSV ───────────────────────────────────────────────────────────
  exportCsvBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/export`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'messages.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      addConsumerMessage('error', e.message);
    }
  });

  // ─── Clear messages ───────────────────────────────────────────────────────
  clearBtn.addEventListener('click', async () => {
    try {
      await fetch(`${API_BASE}/api/clear`, { method: 'POST' });
      messagesEl.innerHTML = '';
      totalBackendMessages = 0;
      previousBackendCount = 0;
      currentPage = 0;
      isSearchActive = false;
      filterEl.value = '';
      paginationEl.style.display = 'none';
      counterEl.style.display = 'none';
      statsBar.style.display = 'none';
    } catch (e) {
      addConsumerMessage('error', e.message);
    }
  });

  // ─── Producer (Send) ──────────────────────────────────────────────────────
  document.getElementById('send-form').addEventListener('submit', async e => {
    e.preventDefault();
    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;

    const serviceUrl = serviceUrlEl.value.trim();
    const topic      = topicEl.value.trim();
    const token      = tokenEl.value.trim();
    const payload    = document.getElementById('sendPayload').value;
    const key        = document.getElementById('sendKey').value.trim();
    const propsRaw   = document.getElementById('sendProps').value.trim();
    let properties;
    if (propsRaw) {
      try { properties = JSON.parse(propsRaw); }
      catch { addProducerMessage('error', 'Properties JSON is invalid'); sendBtn.disabled = false; return; }
    }

    try {
      const res = await fetch(`${API_BASE}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceUrl, topic, payload, key, properties, token }),
      });
      const result = await res.json();
      if (res.ok) {
        addProducerMessage('info', `Sent! MessageId: ${result.messageId}`);
      } else {
        addProducerMessage('error', result.error || 'Send failed');
        if (/unauthori[zs]ed|permission|forbidden/i.test(result.error || '')) {
          showAuthError('Token lacks write permissions for this topic.');
        }
      }
    } catch (err) {
      addProducerMessage('error', String(err));
    }
    sendBtn.disabled = false;
  });

  // ─── Import CSV ───────────────────────────────────────────────────────────
  document.getElementById('importCsvBtn').addEventListener('click', () => {
    document.getElementById('importCsvFile').click();
  });

  document.getElementById('importCsvFile').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const serviceUrl = serviceUrlEl.value.trim();
    const topic      = topicEl.value.trim();
    const token      = tokenEl.value.trim();

    if (!serviceUrl || !topic) {
      addProducerMessage('error', 'Set Service URL and Topic before importing.');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('serviceUrl', serviceUrl);
    formData.append('topic', topic);
    if (token) formData.append('token', token);

    const importBtn       = document.getElementById('importCsvBtn');
    const progressWrap    = document.getElementById('importProgress');
    const progressText    = document.getElementById('importProgressText');
    const progressBar     = document.getElementById('importProgressBar');

    importBtn.disabled = true;
    progressWrap.style.display = 'block';
    progressText.textContent = 'Sending…';
    progressBar.style.width = '0%';

    try {
      const res = await fetch(`${API_BASE}/api/import`, { method: 'POST', body: formData });
      if (!res.ok || !res.body) throw new Error(await res.text() || 'Import failed');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.error) { addProducerMessage('error', `Import failed: ${d.error}`); progressWrap.style.display = 'none'; break; }
            if (d.total !== undefined) {
              progressText.textContent = `Sending ${d.sent} / ${d.total}`;
              progressBar.style.width = d.total > 0 ? `${(100 * d.sent) / d.total}%` : '0%';
            }
            if (d.done) {
              progressText.textContent = `Done — ${d.sent} messages sent`;
              progressBar.style.width = '100%';
              addProducerMessage('info', `Imported ${d.sent} messages.`);
              setTimeout(() => { progressWrap.style.display = 'none'; }, 2500);
            }
          } catch {}
        }
      }
    } catch (err) {
      addProducerMessage('error', `Import failed: ${err.message}`);
      progressWrap.style.display = 'none';
    }
    importBtn.disabled = false;
  });

  // ─── Management Tab ───────────────────────────────────────────────────────
  document.getElementById('loadTopicsBtn').addEventListener('click', loadTopics);
  document.getElementById('refreshStatsBtn').addEventListener('click', () => {
    if (selectedTopic) loadTopicStats(selectedTopic);
  });
  document.getElementById('checkPermsBtn').addEventListener('click', checkPermissions);
  document.getElementById('permsModalClose').addEventListener('click', () => {
    document.getElementById('permsModal').style.display = 'none';
  });

  async function loadTopics() {
    const serviceUrl = serviceUrlEl.value.trim();
    if (!serviceUrl) {
      document.getElementById('topic-list').innerHTML = '<div class="placeholder-text error-text">Set a Service URL first.</div>';
      return;
    }

    const namespace = document.getElementById('namespaceInput').value.trim() || 'public/default';
    const token = tokenEl.value.trim();
    const listEl = document.getElementById('topic-list');
    listEl.innerHTML = '<div class="placeholder-text">Loading…</div>';

    try {
      const params = new URLSearchParams({ serviceUrl, namespace });
      if (token) params.append('token', token);
      const res = await fetch(`${API_BASE}/api/admin/topics?${params}`);
      const data = await res.json();

      if (!res.ok) {
        const msg = data.error || 'Failed to load topics';
        listEl.innerHTML = `<div class="placeholder-text error-text">${msg}</div>`;
        if (data.authFailed) showAuthError('No topics returned — token may lack admin read permissions on this namespace. Try verifying with: curl -H "Authorization: Bearer <token>" <adminUrl>/admin/v2/persistent/<namespace>');
        return;
      }

      if (data.authFailed) {
        showAuthError('No topics returned and the namespace returned an auth error. Your token may not have produce/consume or admin permissions on this namespace.');
      }

      const topics = data.topics || [];
      if (topics.length === 0) {
        listEl.innerHTML = '<div class="placeholder-text">No topics found in this namespace.</div>';
        return;
      }

      listEl.innerHTML = '';
      topics.forEach(t => {
        const item = document.createElement('div');
        item.className = 'topic-item' + (t === selectedTopic ? ' active' : '');
        const shortName = t.replace(/^(persistent|non-persistent):\/\/[^/]+\/[^/]+\//, '');
        item.innerHTML = `<span class="topic-icon">▸</span><span class="topic-name" title="${t}">${shortName}</span>`;
        item.addEventListener('click', () => {
          document.querySelectorAll('.topic-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          selectedTopic = t;
          loadTopicStats(t);
        });
        listEl.appendChild(item);
      });
    } catch (e) {
      listEl.innerHTML = `<div class="placeholder-text error-text">Error: ${e.message}</div>`;
    }
  }

  async function checkPermissions() {
    const serviceUrl = serviceUrlEl.value.trim();
    if (!serviceUrl) { showAuthError('Set a Service URL first.'); return; }

    const namespace = document.getElementById('namespaceInput').value.trim() || 'public/default';
    const token = tokenEl.value.trim();
    const modal = document.getElementById('permsModal');
    const bodyEl = document.getElementById('permsModalBody');
    const baseEl = document.getElementById('permsModalResolvedBase');

    bodyEl.innerHTML = '<div class="perms-loading">Probing admin endpoints…</div>';
    baseEl.textContent = '';
    modal.style.display = 'flex';

    try {
      const params = new URLSearchParams({ serviceUrl, namespace });
      if (token) params.append('token', token);
      const res = await fetch(`${API_BASE}/api/admin/check-permissions?${params}`);
      const data = await res.json();

      if (!res.ok) {
        bodyEl.innerHTML = `<div class="perms-row perms-fail"><span class="perms-status">Error</span><span>${data.error || 'Request failed'}</span></div>`;
        return;
      }

      baseEl.textContent = `Admin URL: ${data.resolvedAdminBase}`;

      bodyEl.innerHTML = '';
      (data.checks || []).forEach(c => {
        const row = document.createElement('div');
        row.className = `perms-row ${c.ok ? 'perms-ok' : 'perms-fail'}`;

        const statusLabel = c.status === 0 ? 'unreachable'
          : c.status === 401 ? '401 Unauthorized'
          : c.status === 403 ? '403 Forbidden'
          : c.status === 404 ? '404 Not Found'
          : c.ok ? `${c.status} OK`
          : `${c.status}`;

        row.innerHTML = `
          <span class="perms-icon">${c.ok ? '✓' : '✕'}</span>
          <span class="perms-endpoint">${c.endpoint}</span>
          <span class="perms-badge ${c.ok ? 'perms-badge-ok' : 'perms-badge-fail'}">${statusLabel}</span>
          ${c.error && !c.ok ? `<span class="perms-error">${c.error}</span>` : ''}
        `;
        bodyEl.appendChild(row);
      });
    } catch (e) {
      bodyEl.innerHTML = `<div class="perms-row perms-fail"><span class="perms-status">Error</span><span>${e.message}</span></div>`;
    }
  }

  async function loadTopicStats(topic) {
    const serviceUrl = serviceUrlEl.value.trim();
    const token = tokenEl.value.trim();
    if (!serviceUrl) return;

    document.getElementById('management-placeholder').style.display = 'none';
    document.getElementById('management-content').style.display = 'block';
    document.getElementById('mgmt-topic-name').textContent = topic.split('/').pop();

    const params = new URLSearchParams({ serviceUrl, topic });
    if (token) params.append('token', token);

    try {
      const res = await fetch(`${API_BASE}/api/admin/topic-stats?${params}`);
      const data = await res.json();
      if (!res.ok) {
        if (data.authFailed || res.status === 401 || res.status === 403) {
          showAuthError(data.error || 'Token lacks read permissions for topic stats.');
        } else {
          showAuthError(data.error || `Failed to load stats (HTTP ${res.status})`);
        }
        document.getElementById('management-placeholder').style.display = 'flex';
        document.getElementById('management-content').style.display = 'none';
        return;
      }
      renderTopicStats(data);
    } catch (e) {
      document.getElementById('management-placeholder').style.display = 'flex';
      document.getElementById('management-content').style.display = 'none';
      showAuthError(`Failed to load stats: ${e.message}`);
    }
  }

  function fmtRate(v) { return v != null ? v.toFixed(2) : '—'; }
  function fmtBytes(v) {
    if (v == null) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + ' GB';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + ' MB';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + ' KB';
    return v + ' B';
  }

  function renderTopicStats(stats) {
    document.getElementById('stat-msgRateIn').textContent      = fmtRate(stats.msgRateIn);
    document.getElementById('stat-msgRateOut').textContent     = fmtRate(stats.msgRateOut);
    document.getElementById('stat-throughputIn').textContent   = fmtBytes(stats.msgThroughputIn);
    document.getElementById('stat-throughputOut').textContent  = fmtBytes(stats.msgThroughputOut);
    document.getElementById('stat-storageSize').textContent    = fmtBytes(stats.storageSize);
    document.getElementById('stat-producers').textContent      = stats.publishers ? stats.publishers.length : (stats.producers || '—');
    document.getElementById('stat-consumers').textContent      = stats.consumers != null ? stats.consumers : '—';

    const subs = stats.subscriptions || {};
    const subKeys = Object.keys(subs);
    document.getElementById('stat-subscriptions').textContent = subKeys.length;

    // Subscriptions table
    const tbody = document.getElementById('subscriptions-tbody');
    tbody.innerHTML = '';
    subKeys.forEach(name => {
      const s = subs[name];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-name">${name}</td>
        <td>${s.type || '—'}</td>
        <td>${(s.consumers || []).length}</td>
        <td>${s.msgBacklog != null ? s.msgBacklog.toLocaleString() : '—'}</td>
        <td>${s.msgRateOut != null ? s.msgRateOut.toFixed(2) : '—'}</td>
      `;
      tbody.appendChild(tr);
    });
    if (subKeys.length === 0) tbody.innerHTML = '<tr><td colspan="5" class="td-empty">No subscriptions</td></tr>';

    // Producers table
    const ptbody = document.getElementById('producers-tbody');
    ptbody.innerHTML = '';
    const producers = stats.publishers || [];
    producers.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-name">${p.producerName || p.name || '—'}</td>
        <td>${p.msgRateIn != null ? p.msgRateIn.toFixed(2) : '—'}</td>
        <td>${fmtBytes(p.msgThroughputIn)}</td>
        <td class="td-addr">${p.address || '—'}</td>
      `;
      ptbody.appendChild(tr);
    });
    if (producers.length === 0) ptbody.innerHTML = '<tr><td colspan="4" class="td-empty">No active producers</td></tr>';
  }

  // ─── Resizable panels ─────────────────────────────────────────────────────
  function makeResizer(resizerEl, targetEl, storageKey, minPx, maxPx) {
    // Restore saved size
    const saved = localStorage.getItem(storageKey);
    if (saved) targetEl.style.width = saved + 'px';

    let startX, startW;

    resizerEl.addEventListener('mousedown', e => {
      e.preventDefault();
      startX = e.clientX;
      startW = targetEl.getBoundingClientRect().width;
      resizerEl.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const delta = e.clientX - startX;
        const newW = Math.min(maxPx, Math.max(minPx, startW + delta));
        targetEl.style.width = newW + 'px';
      }

      function onUp() {
        resizerEl.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(storageKey, parseInt(targetEl.style.width));
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  makeResizer(
    document.getElementById('sidebar-resizer'),
    document.getElementById('sidebar'),
    'pv_sidebar_width', 160, 520
  );

  makeResizer(
    document.getElementById('topic-browser-resizer'),
    document.querySelector('.topic-browser'),
    'pv_topic_browser_width', 140, 600
  );

  // ─── Init ─────────────────────────────────────────────────────────────────
  (async () => {
    await refreshSavedConnections();
    setConnected(false);
  })();
})();
