(function () {
  const MOCK_TOPICS = [
    {
      name: "persistent://public/default/orders",
      rateIn: "1.2k/s",
      rateOut: "890/s",
      storage: "2.4 GB",
      subs: 3,
      producers: 2,
    },
    {
      name: "persistent://public/default/events",
      rateIn: "420/s",
      rateOut: "418/s",
      storage: "890 MB",
      subs: 5,
      producers: 1,
    },
    {
      name: "persistent://public/default/notifications",
      rateIn: "12/s",
      rateOut: "12/s",
      storage: "45 MB",
      subs: 2,
      producers: 1,
    },
  ];

  const BASE_MESSAGES = [
    {
      id: "7142:1:0",
      ts: "2026-04-25T10:12:01.234Z",
      key: "user-1024",
      payload: '{"event":"signup","plan":"pro","region":"eu-west"}',
    },
    {
      id: "7142:1:1",
      ts: "2026-04-25T10:12:03.891Z",
      key: null,
      payload: '{"heartbeat":true,"node":"broker-2"}',
    },
    {
      id: "7142:1:2",
      ts: "2026-04-25T10:12:07.102Z",
      key: "order-991",
      payload: '{"sku":"PV-001","qty":2,"total":49.99}',
    },
  ];

  let messages = [...BASE_MESSAGES];
  let streamTimer = null;

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function renderConsumerTable(filter, useRegex) {
    const tbody = $("#mock-msg-body");
    if (!tbody) return;

    let rows = messages;
    const q = (filter || "").trim();
    if (q) {
      try {
        const re = useRegex ? new RegExp(q, "i") : null;
        rows = messages.filter((m) => {
          const hay = `${m.key || ""} ${m.payload}`;
          return re ? re.test(hay) : hay.toLowerCase().includes(q.toLowerCase());
        });
      } catch {
        rows = [];
      }
    }

    tbody.innerHTML = rows
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.ts)}</td><td>${m.key == null ? "—" : escapeHtml(String(m.key))}</td><td>${escapeHtml(m.payload)}</td><td>${escapeHtml(m.id)}</td></tr>`
      )
      .join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function randomPayload() {
    const kinds = ["click", "purchase", "impression", "error"];
    const k = kinds[Math.floor(Math.random() * kinds.length)];
    return JSON.stringify({
      kind: k,
      ts: new Date().toISOString(),
      value: Math.floor(Math.random() * 1000),
    });
  }

  function appendMockMessage() {
    const last = messages[messages.length - 1];
    const parts = last ? last.id.split(":") : ["9000", "0", "0"];
    const next = String(Number(parts[2] || 0) + 1);
    messages = [
      ...messages,
      {
        id: `${parts[0]}:${parts[1]}:${next}`,
        ts: new Date().toISOString(),
        key: Math.random() > 0.5 ? `sess-${Math.floor(Math.random() * 9999)}` : null,
        payload: randomPayload(),
      },
    ];
    if (messages.length > 50) messages = messages.slice(-50);
    const search = $("#mock-filter");
    const regex = $("#mock-regex");
    renderConsumerTable(search ? search.value : "", regex && regex.checked);
  }

  function renderMgmtTable() {
    const tbody = $("#mock-mgmt-body");
    if (!tbody) return;
    tbody.innerHTML = MOCK_TOPICS.map(
      (t) =>
        `<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.rateIn)}</td><td>${escapeHtml(t.rateOut)}</td><td>${escapeHtml(t.storage)}</td><td>${t.subs}</td><td>${t.producers}</td></tr>`
    ).join("");
  }

  function setupTabs() {
    const tabs = document.querySelectorAll(".demo-tab");
    const panels = document.querySelectorAll(".demo-panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const id = tab.getAttribute("data-tab");
        tabs.forEach((t) => {
          const sel = t.getAttribute("data-tab") === id;
          t.setAttribute("aria-selected", sel ? "true" : "false");
        });
        panels.forEach((p) => {
          const show = p.getAttribute("id") === "panel-" + id;
          p.setAttribute("aria-hidden", show ? "false" : "true");
          if (show) p.removeAttribute("hidden");
          else p.setAttribute("hidden", "hidden");
        });
      });
    });
  }

  function setupConsumer() {
    const search = $("#mock-filter");
    const regex = $("#mock-regex");
    const clearBtn = $("#mock-clear");
    const streamBtn = $("#mock-stream");
    const addBtn = $("#mock-add-one");

    function refresh() {
      renderConsumerTable(search.value, regex.checked);
    }

    if (search) search.addEventListener("input", refresh);
    if (regex) regex.addEventListener("change", refresh);
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        messages = [];
        refresh();
      });
    }
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        appendMockMessage();
      });
    }
    if (streamBtn) {
      streamBtn.addEventListener("click", () => {
        if (streamTimer) {
          clearInterval(streamTimer);
          streamTimer = null;
          streamBtn.textContent = "Simulate stream";
          streamBtn.classList.remove("btn-primary");
          streamBtn.classList.add("btn-ghost");
          return;
        }
        streamTimer = setInterval(appendMockMessage, 1800);
        streamBtn.textContent = "Stop stream";
        streamBtn.classList.add("btn-primary");
        streamBtn.classList.remove("btn-ghost");
      });
    }
    refresh();
  }

  function setupProducer() {
    const form = $("#mock-producer-form");
    const toast = $("#mock-producer-toast");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (toast) {
        toast.textContent =
          "Mock only: the real app publishes to your Pulsar topic. Clone the repo or install a release to try it.";
        toast.classList.add("visible");
        setTimeout(() => toast.classList.remove("visible"), 5000);
      }
    });
  }

  function setupCopy() {
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sel = btn.getAttribute("data-copy-target");
        const el = sel ? document.querySelector(sel) : null;
        const text = el ? el.textContent.trim() : "";
        try {
          await navigator.clipboard.writeText(text);
          const prev = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = prev;
          }, 1500);
        } catch {
          btn.textContent = "Copy failed";
        }
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupTabs();
    setupConsumer();
    setupProducer();
    renderMgmtTable();
    setupCopy();
    const year = $("#year");
    if (year) year.textContent = String(new Date().getFullYear());
  });
})();
