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
  let managementAutoRefreshTimer = null;
  let managementAutoRefreshEnabled = true;
  let managementAutoRefreshInterval = 10; // seconds
  let managementTopicsLoaded = false;

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
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));

    if (tab === 'management' && isConnected) {
      deriveNamespaceFromTopic();
      if (!managementTopicsLoaded) loadTopics();
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  }

  function deriveNamespaceFromTopic() {
    const topic = topicEl.value.trim();
    if (!topic) return;
    // persistent://tenant/namespace/topicname → tenant/namespace
    const match = topic.match(/^(?:persistent|non-persistent):\/\/([^/]+\/[^/]+)\//);
    if (match) {
      document.getElementById('namespaceInput').value = match[1];
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

    if (connected) {
      deriveNamespaceFromTopic();
      managementTopicsLoaded = false;
      loadTopicsInBackground();
    } else {
      stopAutoRefresh();
      managementTopicsLoaded = false;
    }
  }

  function loadTopicsInBackground() {
    const serviceUrl = serviceUrlEl.value.trim();
    if (!serviceUrl) return;
    loadTopics();
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
    refreshTemplatesList();
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

  function fmtTimestamp(ms) {
    if (!ms) return null;
    const d = new Date(ms);
    return d.toLocaleString() + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function buildDetailPanel(msg) {
    const props = msg.properties || {};
    const propKeys = Object.keys(props);

    const publishFmt = fmtTimestamp(msg.publishTime);
    const eventFmt = fmtTimestamp(msg.eventTime);

    let html = '';

    html += `<div class="msg-detail-section">
      <div class="msg-detail-title">Identity</div>
      <div class="msg-detail-row"><span class="msg-detail-label">Message ID</span><span class="msg-detail-value">${msg.id || '<span class="msg-detail-value-empty">—</span>'}</span></div>
      <div class="msg-detail-row"><span class="msg-detail-label">Key</span><span class="msg-detail-value">${msg.key || '<span class="msg-detail-value-empty">none</span>'}</span></div>
    </div>`;

    html += `<div class="msg-detail-section">
      <div class="msg-detail-title">Timestamps</div>
      <div class="msg-detail-row"><span class="msg-detail-label">Published</span><span class="msg-detail-value">${publishFmt || '<span class="msg-detail-value-empty">—</span>'}</span></div>
      <div class="msg-detail-row"><span class="msg-detail-label">Event Time</span><span class="msg-detail-value">${eventFmt || '<span class="msg-detail-value-empty">not set</span>'}</span></div>
    </div>`;

    html += `<div class="msg-detail-section">
      <div class="msg-detail-title">Properties (${propKeys.length})</div>`;
    if (propKeys.length === 0) {
      html += `<div class="msg-detail-row"><span class="msg-detail-value-empty">No properties</span></div>`;
    } else {
      propKeys.forEach(k => {
        html += `<div class="msg-detail-row">
          <span class="msg-prop-badge"><span class="msg-prop-key">${escHtml(k)}</span></span>
          <span class="msg-detail-value">${escHtml(props[k])}</span>
        </div>`;
      });
    }
    html += `</div>`;

    return html;
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildMessageEl(msg) {
    const container = document.createElement('div');
    container.className = 'msg msg-message msg-clickable';
    container.dataset.msgId = msg.id || '';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span class="msg-icon msg-icon-message">▶</span>
      <span class="msg-time">${msg.publishTime ? new Date(msg.publishTime).toLocaleTimeString() : ''}</span>
      ${msg.key ? `<span class="msg-key">${msg.key}</span>` : ''}
      <span class="msg-hint">click to inspect</span>`;

    const body = document.createElement('div');
    body.className = 'msg-body';

    const payloadCol = document.createElement('div');
    payloadCol.className = 'msg-payload-col';
    const pre = document.createElement('pre');
    pre.className = 'msg-payload';
    pre.innerHTML = syntaxHighlight(msg.payload || JSON.stringify(msg, null, 2));
    payloadCol.appendChild(pre);

    const detailCol = document.createElement('div');
    detailCol.className = 'msg-detail-col';
    detailCol.innerHTML = buildDetailPanel(msg);

    body.appendChild(payloadCol);
    body.appendChild(detailCol);

    container.appendChild(meta);
    container.appendChild(body);

    container.addEventListener('click', () => {
      container.classList.toggle('msg-expanded');
    });

    return container;
  }

  function renderMessages(msgs) {
    const existingEls = messagesEl.querySelectorAll('.msg-message[data-msg-id]');
    const existingById = new Map();
    existingEls.forEach(el => {
      const id = el.dataset.msgId;
      if (id) existingById.set(id, el);
    });

    const expandedIds = new Set();
    existingEls.forEach(el => {
      if (el.classList.contains('msg-expanded') && el.dataset.msgId) {
        expandedIds.add(el.dataset.msgId);
      }
    });

    const incomingIds = new Set(msgs.map(m => m.id).filter(Boolean));
    const needsFullRebuild = existingById.size === 0
      || msgs.length === 0
      || (incomingIds.size > 0 && [...existingById.keys()].every(id => !incomingIds.has(id)));

    if (needsFullRebuild) {
      const fragment = document.createDocumentFragment();
      msgs.forEach(msg => {
        const el = buildMessageEl(msg);
        if (msg.id && expandedIds.has(msg.id)) el.classList.add('msg-expanded');
        fragment.appendChild(el);
      });
      messagesEl.innerHTML = '';
      messagesEl.appendChild(fragment);
      return;
    }

    const newIds = new Set();
    msgs.forEach(msg => { if (msg.id) newIds.add(msg.id); });

    // Remove messages no longer in the list
    existingById.forEach((el, id) => {
      if (!newIds.has(id)) el.remove();
    });

    // Append new messages that don't exist yet, preserve existing ones
    let lastEl = null;
    msgs.forEach(msg => {
      const id = msg.id || '';
      const existing = id ? existingById.get(id) : null;
      if (existing) {
        if (lastEl && lastEl.nextSibling !== existing) {
          messagesEl.insertBefore(existing, lastEl.nextSibling);
        }
        lastEl = existing;
      } else {
        const el = buildMessageEl(msg);
        if (id && expandedIds.has(id)) el.classList.add('msg-expanded');
        if (lastEl) {
          lastEl.insertAdjacentElement('afterend', el);
        } else {
          messagesEl.prepend(el);
        }
        lastEl = el;
      }
    });
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

  // ─── Properties Editor ──────────────────────────────────────────────────
  const propsEditorEl = document.getElementById('propsEditor');
  const addPropBtn = document.getElementById('addPropBtn');

  function addPropRow(key, value) {
    const empty = propsEditorEl.querySelector('.props-empty');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'prop-row';
    row.innerHTML = `
      <input type="text" class="prop-key" placeholder="key" value="${escHtml(key || '')}" />
      <input type="text" class="prop-val" placeholder="value" value="${escHtml(value || '')}" />
      <button type="button" class="prop-remove-btn" title="Remove">&times;</button>
    `;
    row.querySelector('.prop-remove-btn').addEventListener('click', () => {
      row.remove();
      if (propsEditorEl.children.length === 0) {
        propsEditorEl.innerHTML = '<div class="props-empty">No properties — click + Add</div>';
      }
    });
    propsEditorEl.appendChild(row);
    row.querySelector('.prop-key').focus();
  }

  function getPropertiesFromEditor() {
    const rows = propsEditorEl.querySelectorAll('.prop-row');
    if (rows.length === 0) return undefined;
    const props = {};
    rows.forEach(row => {
      const k = row.querySelector('.prop-key').value.trim();
      const v = row.querySelector('.prop-val').value;
      if (k) props[k] = v;
    });
    return Object.keys(props).length > 0 ? props : undefined;
  }

  function setPropertiesInEditor(propsObj) {
    propsEditorEl.innerHTML = '';
    if (!propsObj || typeof propsObj !== 'object' || Object.keys(propsObj).length === 0) {
      propsEditorEl.innerHTML = '<div class="props-empty">No properties — click + Add</div>';
      return;
    }
    Object.entries(propsObj).forEach(([k, v]) => addPropRow(k, v));
  }

  addPropBtn.addEventListener('click', () => addPropRow('', ''));

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
    const properties = getPropertiesFromEditor();

    const useProtobuf = protoActive && sendAsProtobufEl.checked;

    try {
      const res = await fetch(`${API_BASE}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceUrl, topic, payload, key, properties, token, useProtobuf }),
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
  document.getElementById('loadTopicsBtn').addEventListener('click', () => {
    managementTopicsLoaded = false;
    loadTopics();
  });
  document.getElementById('refreshStatsBtn').addEventListener('click', () => {
    if (selectedTopic) loadTopicStats(selectedTopic);
  });
  document.getElementById('autorefresh-toggle').addEventListener('click', () => {
    managementAutoRefreshEnabled = !managementAutoRefreshEnabled;
    const btn = document.getElementById('autorefresh-toggle');
    btn.classList.toggle('active', managementAutoRefreshEnabled);
    if (managementAutoRefreshEnabled) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
    updateAutoRefreshCountdown();
  });
  document.getElementById('autorefresh-interval').addEventListener('change', e => {
    managementAutoRefreshInterval = parseInt(e.target.value, 10) || 10;
    if (managementAutoRefreshEnabled) startAutoRefresh();
    updateAutoRefreshCountdown();
  });
  document.getElementById('checkPermsBtn').addEventListener('click', checkPermissions);
  document.getElementById('permsModalClose').addEventListener('click', () => {
    document.getElementById('permsModal').style.display = 'none';
  });

  function groupPartitionedTopics(topics) {
    const groups = new Map();
    const partitionRe = /-partition-(\d+)$/;

    topics.forEach(fullName => {
      const shortName = fullName.replace(/^(persistent|non-persistent):\/\/[^/]+\/[^/]+\//, '');
      const match = shortName.match(partitionRe);
      if (match) {
        const baseName = shortName.replace(partitionRe, '');
        const prefix = fullName.slice(0, fullName.length - shortName.length);
        if (!groups.has(baseName)) {
          groups.set(baseName, { baseName, prefix, partitions: [] });
        }
        groups.get(baseName).partitions.push({ index: parseInt(match[1], 10), fullName });
      } else {
        const prefix = fullName.slice(0, fullName.length - shortName.length);
        groups.set(shortName, { baseName: shortName, prefix, partitions: [{ index: -1, fullName }] });
      }
    });

    groups.forEach(g => g.partitions.sort((a, b) => a.index - b.index));
    return Array.from(groups.values());
  }

  async function loadTopics() {
    const serviceUrl = serviceUrlEl.value.trim();
    if (!serviceUrl) {
      document.getElementById('topic-list').innerHTML = '<div class="placeholder-text error-text">Set a Service URL first.</div>';
      return;
    }

    const namespace = document.getElementById('namespaceInput').value.trim() || 'public/default';
    const token = tokenEl.value.trim();
    const listEl = document.getElementById('topic-list');
    listEl.innerHTML = '<div class="placeholder-text">Loading\u2026</div>';

    try {
      const params = new URLSearchParams({ serviceUrl, namespace });
      if (token) params.append('token', token);
      const res = await fetch(`${API_BASE}/api/admin/topics?${params}`);
      const data = await res.json();

      if (!res.ok) {
        const msg = data.error || 'Failed to load topics';
        listEl.innerHTML = `<div class="placeholder-text error-text">${msg}</div>`;
        if (data.authFailed) showAuthError('No topics returned \u2014 token may lack admin read permissions on this namespace. Try verifying with: curl -H "Authorization: Bearer <token>" <adminUrl>/admin/v2/persistent/<namespace>');
        return;
      }

      if (data.authFailed) {
        showAuthError('No topics returned and the namespace returned an auth error. Your token may not have produce/consume or admin permissions on this namespace.');
      }

      const topics = data.topics || [];
      if (topics.length === 0) {
        listEl.innerHTML = '<div class="placeholder-text">No topics found in this namespace.</div>';
        managementTopicsLoaded = true;
        return;
      }

      const grouped = groupPartitionedTopics(topics);
      listEl.innerHTML = '';

      grouped.forEach(group => {
        const isPartitioned = group.partitions.length > 1 || group.partitions[0]?.index >= 0;
        const firstPartition = group.partitions[0]?.fullName;
        const item = document.createElement('div');
        item.className = 'topic-group';

        const header = document.createElement('div');
        header.className = 'topic-item' + (selectedTopic === firstPartition ? ' active' : '');
        const partBadge = isPartitioned
          ? `<span class="partition-badge" title="${group.partitions.length} partitions">${group.partitions.length}p</span>`
          : '';
        header.innerHTML = `<span class="topic-icon">\u25B8</span><span class="topic-name" title="${group.prefix}${group.baseName}">${group.baseName}</span>${partBadge}`;

        header.addEventListener('click', () => {
          document.querySelectorAll('.topic-item').forEach(i => i.classList.remove('active'));
          header.classList.add('active');
          selectedTopic = firstPartition;
          if (isPartitioned) {
            loadPartitionedTopicStats(group);
          } else {
            loadTopicStats(firstPartition);
          }
        });
        item.appendChild(header);

        if (isPartitioned) {
          const partList = document.createElement('div');
          partList.className = 'partition-list collapsed';
          partList.id = `partitions-${group.baseName.replace(/[^a-zA-Z0-9-]/g, '_')}`;

          group.partitions.forEach(p => {
            const pItem = document.createElement('div');
            pItem.className = 'partition-item';
            pItem.innerHTML = `<span class="partition-dot">\u25AA</span><span class="partition-name">partition-${p.index}</span>`;
            pItem.addEventListener('click', e => {
              e.stopPropagation();
              document.querySelectorAll('.topic-item').forEach(i => i.classList.remove('active'));
              header.classList.add('active');
              selectedTopic = p.fullName;
              loadTopicStats(p.fullName);
            });
            partList.appendChild(pItem);
          });

          const expandBtn = document.createElement('button');
          expandBtn.className = 'partition-expand-btn';
          expandBtn.textContent = '\u25B8';
          expandBtn.title = 'Show partitions';
          expandBtn.addEventListener('click', e => {
            e.stopPropagation();
            const collapsed = partList.classList.toggle('collapsed');
            expandBtn.textContent = collapsed ? '\u25B8' : '\u25BE';
          });
          header.prepend(expandBtn);
          header.querySelector('.topic-icon').remove();

          item.appendChild(partList);
        }

        listEl.appendChild(item);
      });

      managementTopicsLoaded = true;
    } catch (e) {
      listEl.innerHTML = `<div class="placeholder-text error-text">Error: ${e.message}</div>`;
    }
  }

  async function loadPartitionedTopicStats(group) {
    const serviceUrl = serviceUrlEl.value.trim();
    const token = tokenEl.value.trim();
    if (!serviceUrl) return;

    document.getElementById('management-placeholder').style.display = 'none';
    document.getElementById('management-content').style.display = 'block';
    document.getElementById('mgmt-topic-name').textContent = group.baseName;

    const params = new URLSearchParams({ serviceUrl, topic: group.partitions[0].fullName });
    if (token) params.append('token', token);

    try {
      const res = await fetch(`${API_BASE}/api/admin/topic-stats?${params}`);
      const data = await res.json();
      if (!res.ok) {
        if (data.authFailed || res.status === 401 || res.status === 403) {
          showAuthError(data.error || 'Token lacks read permissions for topic stats.');
        }
        return;
      }
      renderTopicStats(data);
      renderPartitionSummary(group);
      startAutoRefresh();
    } catch (e) {
      showAuthError(`Failed to load stats: ${e.message}`);
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
      hidePartitionSummary();
      startAutoRefresh();
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

  // ─── Partition Summary ───────────────────────────────────────────────────
  function renderPartitionSummary(group) {
    let wrap = document.getElementById('partition-summary');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'partition-summary';
      wrap.className = 'mgmt-section';
      const content = document.getElementById('management-content');
      const firstSection = content.querySelector('.mgmt-section');
      content.insertBefore(wrap, firstSection);
    }
    wrap.style.display = 'block';
    wrap.innerHTML = `
      <div class="mgmt-section-title">Partitions</div>
      <div class="partition-summary-cards">
        ${group.partitions.map(p => `
          <div class="partition-card" data-topic="${p.fullName}">
            <div class="partition-card-index">partition-${p.index}</div>
            <div class="partition-card-loading">loading\u2026</div>
          </div>
        `).join('')}
      </div>
    `;

    const serviceUrl = serviceUrlEl.value.trim();
    const token = tokenEl.value.trim();
    group.partitions.forEach(p => {
      loadPartitionCardStats(p.fullName, serviceUrl, token);
    });

    wrap.querySelectorAll('.partition-card').forEach(card => {
      card.addEventListener('click', () => {
        const topicFull = card.dataset.topic;
        selectedTopic = topicFull;
        loadTopicStats(topicFull);
      });
    });
  }

  async function loadPartitionCardStats(topicFull, serviceUrl, token) {
    const card = document.querySelector(`.partition-card[data-topic="${topicFull}"]`);
    if (!card) return;
    const params = new URLSearchParams({ serviceUrl, topic: topicFull });
    if (token) params.append('token', token);
    try {
      const res = await fetch(`${API_BASE}/api/admin/topic-stats?${params}`);
      const data = await res.json();
      if (!res.ok) {
        card.querySelector('.partition-card-loading').textContent = 'error';
        return;
      }
      card.querySelector('.partition-card-loading').innerHTML = `
        <span class="pc-stat">\u2191 ${fmtRate(data.msgRateIn)}/s</span>
        <span class="pc-stat">\u2193 ${fmtRate(data.msgRateOut)}/s</span>
        <span class="pc-stat">${fmtBytes(data.storageSize)}</span>
      `;
    } catch {
      card.querySelector('.partition-card-loading').textContent = 'error';
    }
  }

  function hidePartitionSummary() {
    const wrap = document.getElementById('partition-summary');
    if (wrap) wrap.style.display = 'none';
  }

  // ─── Auto-refresh ──────────────────────────────────────────────────────
  function startAutoRefresh() {
    stopAutoRefresh();
    if (!managementAutoRefreshEnabled || !selectedTopic) return;
    updateAutoRefreshCountdown();
    managementAutoRefreshTimer = setInterval(() => {
      if (selectedTopic && activeTab === 'management') {
        refreshCurrentTopic();
      }
    }, managementAutoRefreshInterval * 1000);
  }

  function stopAutoRefresh() {
    if (managementAutoRefreshTimer) {
      clearInterval(managementAutoRefreshTimer);
      managementAutoRefreshTimer = null;
    }
  }

  function refreshCurrentTopic() {
    if (!selectedTopic) return;
    loadTopicStats(selectedTopic);
  }

  function updateAutoRefreshCountdown() {
    const badge = document.getElementById('autorefresh-badge');
    if (badge) {
      badge.textContent = managementAutoRefreshEnabled
        ? `Auto-refresh: ${managementAutoRefreshInterval}s`
        : 'Auto-refresh: off';
    }
  }

  // ─── Protobuf Schema ─────────────────────────────────────────────────────
  let protoActive = false;
  let protoFileContent = null;

  const protoArrow = document.getElementById('proto-arrow');
  const protoSectionBody = document.getElementById('proto-section-body');
  const protoSourceEl = document.getElementById('protoSource');
  const protoMsgTypeRow = document.getElementById('protoMsgTypeRow');
  const protoMsgTypeEl = document.getElementById('protoMsgType');
  const protoRegisterBtn = document.getElementById('protoRegisterBtn');
  const protoClearBtn = document.getElementById('protoClearBtn');
  const protoStatusEl = document.getElementById('protoStatus');
  const protoEncodeBadge = document.getElementById('protoEncodeBadge');
  const protoSendOptions = document.getElementById('protoSendOptions');
  const sendAsProtobufEl = document.getElementById('sendAsProtobuf');

  document.getElementById('proto-section-toggle').addEventListener('click', () => {
    const collapsed = protoSectionBody.classList.toggle('collapsed');
    protoArrow.textContent = collapsed ? '\u25B8' : '\u25BE';
  });

  // Proto tab switching (Paste / File)
  document.querySelectorAll('.proto-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.proto-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.protoTab;
      document.getElementById('proto-paste-panel').style.display = tab === 'paste' ? '' : 'none';
      document.getElementById('proto-file-panel').style.display = tab === 'file' ? '' : 'none';
    });
  });

  // File upload
  const protoFileDrop = document.getElementById('protoFileDrop');
  const protoFileInput = document.getElementById('protoFileInput');
  const protoFileName = document.getElementById('protoFileName');

  protoFileDrop.addEventListener('click', () => protoFileInput.click());
  protoFileDrop.addEventListener('dragover', e => { e.preventDefault(); protoFileDrop.classList.add('drag-over'); });
  protoFileDrop.addEventListener('dragleave', () => protoFileDrop.classList.remove('drag-over'));
  protoFileDrop.addEventListener('drop', e => {
    e.preventDefault();
    protoFileDrop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) readProtoFile(file);
  });
  protoFileInput.addEventListener('change', e => {
    if (e.target.files[0]) readProtoFile(e.target.files[0]);
    e.target.value = '';
  });

  function readProtoFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      protoFileContent = reader.result;
      protoFileName.textContent = file.name;
      protoFileName.style.display = 'block';
    };
    reader.readAsText(file);
  }

  protoRegisterBtn.addEventListener('click', registerProtoSchema);

  async function registerProtoSchema() {
    const activeTab = document.querySelector('.proto-tab.active')?.dataset.protoTab;
    let source = activeTab === 'file' ? protoFileContent : protoSourceEl.value.trim();
    if (!source) {
      protoStatusEl.textContent = 'Provide a .proto definition first.';
      protoStatusEl.className = 'proto-status proto-status-error';
      return;
    }

    protoRegisterBtn.disabled = true;
    protoStatusEl.textContent = 'Registering...';
    protoStatusEl.className = 'proto-status proto-status-info';

    try {
      const res = await fetch(`${API_BASE}/api/proto/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, messageType: protoMsgTypeEl.value || '' }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        protoStatusEl.textContent = data.error || 'Registration failed';
        protoStatusEl.className = 'proto-status proto-status-error';
        return;
      }

      const types = data.messageTypes || [];
      if (types.length > 1 && !data.selected) {
        protoMsgTypeEl.innerHTML = types.map(t => `<option value="${t}">${t}</option>`).join('');
        protoMsgTypeRow.style.display = '';
        protoStatusEl.textContent = `Found ${types.length} message types. Select one and register again.`;
        protoStatusEl.className = 'proto-status proto-status-info';
        return;
      }

      if (types.length > 1) {
        protoMsgTypeEl.innerHTML = types.map(t => `<option value="${t}" ${t === data.selected ? 'selected' : ''}>${t}</option>`).join('');
        protoMsgTypeRow.style.display = '';
      }

      setProtoActive(true, data.selected);
      protoStatusEl.textContent = `Active: ${data.selected}`;
      protoStatusEl.className = 'proto-status proto-status-ok';
    } catch (e) {
      protoStatusEl.textContent = 'Error: ' + e.message;
      protoStatusEl.className = 'proto-status proto-status-error';
    } finally {
      protoRegisterBtn.disabled = false;
    }
  }

  protoMsgTypeEl.addEventListener('change', async () => {
    if (!protoActive) return;
    const source = protoSourceEl.value.trim() || protoFileContent;
    if (!source) return;
    try {
      const res = await fetch(`${API_BASE}/api/proto/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, messageType: protoMsgTypeEl.value }),
      });
      const data = await res.json();
      if (data.ok && data.selected) {
        protoStatusEl.textContent = `Active: ${data.selected}`;
        protoStatusEl.className = 'proto-status proto-status-ok';
      }
    } catch {}
  });

  protoClearBtn.addEventListener('click', async () => {
    try { await fetch(`${API_BASE}/api/proto/clear`, { method: 'POST' }); } catch {}
    setProtoActive(false, '');
    protoStatusEl.textContent = 'Schema cleared.';
    protoStatusEl.className = 'proto-status proto-status-info';
    protoMsgTypeRow.style.display = 'none';
    setTimeout(() => { protoStatusEl.textContent = ''; }, 2000);
  });

  function setProtoActive(active, typeName) {
    protoActive = active;
    protoClearBtn.style.display = active ? '' : 'none';
    protoEncodeBadge.style.display = active ? '' : 'none';
    protoSendOptions.style.display = active ? '' : 'none';
    if (active) {
      protoEncodeBadge.textContent = typeName || 'protobuf';
    }
  }

  document.getElementById('protoFillTemplate').addEventListener('click', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/proto/template`);
      const data = await res.json();
      if (data.ok && data.template) {
        document.getElementById('sendPayload').value = JSON.stringify(data.template, null, 2);
      }
    } catch (e) {
      addProducerMessage('error', 'Failed to generate template: ' + e.message);
    }
  });

  // ─── Message Templates ─────────────────────────────────────────────────────
  const templateNameEl = document.getElementById('templateName');
  const saveTemplateBtn = document.getElementById('saveTemplateBtn');
  const templatesListEl = document.getElementById('templates-list');

  function getTemplateStorageKey() {
    return `pvTemplates_${selectedConnectionLabel || '_global'}`;
  }

  function loadTemplates() {
    const key = getTemplateStorageKey();
    try {
      return JSON.parse(localStorage.getItem(key) || '{}');
    } catch { return {}; }
  }

  function saveTemplates(templates) {
    localStorage.setItem(getTemplateStorageKey(), JSON.stringify(templates));
  }

  function refreshTemplatesList() {
    const templates = loadTemplates();
    const names = Object.keys(templates);
    templatesListEl.innerHTML = '';

    if (names.length === 0) {
      templatesListEl.innerHTML = '<div class="conn-empty">No saved templates</div>';
      return;
    }

    names.forEach(name => {
      const item = document.createElement('div');
      item.className = 'template-item';
      item.innerHTML = `
        <span class="template-icon">&#9654;</span>
        <span class="template-name" title="${name}">${name}</span>
        <button class="template-load-btn btn-sm btn-ghost" title="Load">Load</button>
        <button class="template-delete-btn btn-sm btn-ghost-danger" title="Delete">&times;</button>
      `;
      item.querySelector('.template-load-btn').addEventListener('click', e => {
        e.stopPropagation();
        loadTemplate(name);
      });
      item.querySelector('.template-delete-btn').addEventListener('click', e => {
        e.stopPropagation();
        deleteTemplate(name);
      });
      item.addEventListener('click', () => loadTemplate(name));
      templatesListEl.appendChild(item);
    });
  }

  function loadTemplate(name) {
    const templates = loadTemplates();
    const tmpl = templates[name];
    if (!tmpl) return;
    document.getElementById('sendKey').value = tmpl.key || '';
    document.getElementById('sendPayload').value = tmpl.payload || '';
    templateNameEl.value = name;

    let propsObj = tmpl.properties;
    if (typeof propsObj === 'string' && propsObj.trim()) {
      try { propsObj = JSON.parse(propsObj); } catch { propsObj = null; }
    }
    setPropertiesInEditor(propsObj || null);

    addProducerMessage('info', `Loaded template: ${name}`);
  }

  function deleteTemplate(name) {
    if (!confirm(`Delete template "${name}"?`)) return;
    const templates = loadTemplates();
    delete templates[name];
    saveTemplates(templates);
    refreshTemplatesList();
  }

  saveTemplateBtn.addEventListener('click', () => {
    const name = templateNameEl.value.trim();
    if (!name) { templateNameEl.focus(); return; }

    const templates = loadTemplates();
    templates[name] = {
      key: document.getElementById('sendKey').value.trim(),
      properties: getPropertiesFromEditor() || {},
      payload: document.getElementById('sendPayload').value,
    };
    saveTemplates(templates);
    refreshTemplatesList();
    addProducerMessage('info', `Saved template: ${name}`);
  });

  // ─── Config Export / Import ──────────────────────────────────────────────
  document.getElementById('exportConfigBtn').addEventListener('click', exportConfig);
  document.getElementById('importConfigBtn').addEventListener('click', () => {
    document.getElementById('importConfigFile').click();
  });
  document.getElementById('importConfigFile').addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = () => importConfig(reader.result);
    reader.readAsText(file);
  });

  function gatherConfig() {
    const config = {
      _pv_config_version: 1,
      _pv_exported_at: new Date().toISOString(),
      connections: JSON.parse(localStorage.getItem('pulsarConnections') || '{}'),
      templates: {},
      preferences: {},
    };

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('pvTemplates_')) {
        try { config.templates[key] = JSON.parse(localStorage.getItem(key)); } catch {}
      }
    }

    const sidebarW = localStorage.getItem('pv_sidebar_width');
    const topicW = localStorage.getItem('pv_topic_browser_width');
    if (sidebarW) config.preferences.pv_sidebar_width = parseInt(sidebarW);
    if (topicW) config.preferences.pv_topic_browser_width = parseInt(topicW);

    return config;
  }

  function exportConfig() {
    const config = gatherConfig();
    const connCount = Object.keys(config.connections).length;
    const tmplCount = Object.values(config.templates).reduce((sum, t) => sum + Object.keys(t).length, 0);

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pulsarviewer-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);

    addConsumerMessage('info', `Exported config: ${connCount} connection(s), ${tmplCount} template(s).`);
  }

  function importConfig(jsonStr) {
    let config;
    try {
      config = JSON.parse(jsonStr);
    } catch {
      addConsumerMessage('error', 'Invalid config file — could not parse JSON.');
      return;
    }

    if (!config._pv_config_version) {
      addConsumerMessage('error', 'Invalid config file — missing version marker.');
      return;
    }

    const existing = JSON.parse(localStorage.getItem('pulsarConnections') || '{}');
    const incoming = config.connections || {};
    const conflicts = Object.keys(incoming).filter(k => existing[k]);

    let merge = true;
    if (conflicts.length > 0) {
      merge = confirm(
        `${conflicts.length} connection(s) already exist (${conflicts.join(', ')}).\n\nOverwrite duplicates?`
      );
      if (!merge) {
        Object.keys(incoming).forEach(k => {
          if (existing[k]) delete incoming[k];
        });
      }
    }

    const merged = { ...existing, ...incoming };
    localStorage.setItem('pulsarConnections', JSON.stringify(merged));

    if (config.templates) {
      for (const [key, value] of Object.entries(config.templates)) {
        if (!key.startsWith('pvTemplates_')) continue;
        const existingTmpl = JSON.parse(localStorage.getItem(key) || '{}');
        localStorage.setItem(key, JSON.stringify({ ...existingTmpl, ...value }));
      }
    }

    if (config.preferences) {
      if (config.preferences.pv_sidebar_width) {
        localStorage.setItem('pv_sidebar_width', config.preferences.pv_sidebar_width);
        document.getElementById('sidebar').style.width = config.preferences.pv_sidebar_width + 'px';
      }
      if (config.preferences.pv_topic_browser_width) {
        localStorage.setItem('pv_topic_browser_width', config.preferences.pv_topic_browser_width);
        const tb = document.querySelector('.topic-browser');
        if (tb) tb.style.width = config.preferences.pv_topic_browser_width + 'px';
      }
    }

    const connCount = Object.keys(incoming).length;
    const tmplCount = config.templates
      ? Object.values(config.templates).reduce((sum, t) => sum + Object.keys(t).length, 0)
      : 0;

    refreshSavedConnections();
    refreshTemplatesList();
    addConsumerMessage('info', `Imported config: ${connCount} connection(s), ${tmplCount} template(s).`);
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
    refreshTemplatesList();
    setConnected(false);

    // Restore proto status on load
    try {
      const res = await fetch(`${API_BASE}/api/proto/status`);
      const data = await res.json();
      if (data.active) {
        setProtoActive(true, data.messageType);
        protoStatusEl.textContent = `Active: ${data.messageType}`;
        protoStatusEl.className = 'proto-status proto-status-ok';
        if (data.source) protoSourceEl.value = data.source;
        if (data.messageTypes && data.messageTypes.length > 1) {
          protoMsgTypeEl.innerHTML = data.messageTypes.map(t => `<option value="${t}" ${t === data.messageType ? 'selected' : ''}>${t}</option>`).join('');
          protoMsgTypeRow.style.display = '';
        }
      }
    } catch {}
  })();
})();
