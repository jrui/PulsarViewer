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

  let evtSource = null;

  const counterEl = document.createElement('div');
  counterEl.id = 'counter';
  counterEl.textContent = '0 messages';
  document.getElementById('messages').before(counterEl);
  let count = 0;

  function syntaxHighlight(jsonStr) {
    return jsonStr.replace(/\"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*\"(?=:)/g, m => `<span class="key">${m}</span>`) // keys
      .replace(/:\s*\"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*\"/g, m => m.replace(/\"([^\"]*)\"$/, v => v.replace(/\"/g, '"'))) // keep values
  }

  function addMessage(kind, payload) {
    if (pauseEl.checked) return;
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
    // Append filter if present in the UI
    const filterEl = document.getElementById('filter');
    if (filterEl && filterEl.value.trim()) params.append('filter', filterEl.value.trim());

    addMessage('info', 'Opening stream...');
  evtSource = new EventSource(`/api/stream?${params.toString()}`);

    evtSource.addEventListener('info', e => {
      addMessage('info', JSON.parse(e.data));
    });
    evtSource.addEventListener('error', e => {
      try { addMessage('error', JSON.parse(e.data)); } catch { addMessage('error', 'Stream error'); }
    });
    evtSource.addEventListener('message', e => {
      try { addMessage('message', JSON.parse(e.data)); } catch { addMessage('message', e.data); }
    });
    evtSource.onerror = () => {
      addMessage('error', 'Connection lost');
      disconnect();
    };

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  }

  function disconnect() {
    if (evtSource) {
      evtSource.close();
      evtSource = null;
      addMessage('info', 'Disconnected');
    }
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }

  function clearMessages() {
    messagesEl.innerHTML = '';
    count = 0;
    counterEl.textContent = '';
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
