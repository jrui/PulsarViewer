(() => {
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
  const pauseEl = document.getElementById('pause');
  const filterEl = document.getElementById('filter');
  const useRegexEl = document.getElementById('useRegex');

  let evtSource = null;
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
    if (pauseEl.checked) return;
    
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
    const params = new URLSearchParams({
      serviceUrl: serviceUrlEl.value.trim(),
      topic: topicEl.value.trim(),
      subscription: subscriptionEl.value.trim(),
      subscriptionType: subscriptionTypeEl.value,
    });
    const token = tokenEl.value.trim();
    if (token) params.append('token', token);
    // Note: No longer sending filter to backend - filtering happens on frontend

    addMessage('info', 'Opening stream...', true);
    evtSource = new EventSource(`/api/stream?${params.toString()}`);

    evtSource.addEventListener('info', e => {
      addMessage('info', JSON.parse(e.data), true);
    });
    evtSource.addEventListener('error', e => {
      try { addMessage('error', JSON.parse(e.data), true); } catch { addMessage('error', 'Stream error', true); }
    });
    evtSource.addEventListener('message', e => {
      let msgData;
      try { 
        msgData = JSON.parse(e.data);
      } catch { 
        msgData = e.data;
      }
      allMessages.push(msgData); // Store all messages
      addMessage('message', msgData); // Display with filtering
    });
    evtSource.onerror = () => {
      addMessage('error', 'Connection lost', true);
      disconnect();
    };

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
