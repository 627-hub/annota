// video-annotate · MV3 后台：代发同步请求 + 截图（都在扩展上下文，不受页面 CORS/混合内容限制）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;

  if (msg.type === 'va-fetch') {
    (async () => {
      try {
        if (!/^https?:\/\//i.test(String(msg.url || ''))) {
          sendResponse({ ok: false, status: 0, error: '仅支持 http(s) 地址' });
          return;
        }
        const r = await fetch(msg.url, {
          method: msg.method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });
        let json = null;
        try { json = await r.json(); } catch (e) {}
        sendResponse({ ok: r.ok, status: r.status, json });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步响应
  }

  if (msg.type === 'va-capture') {
    try {
      // 用 sender.tab.windowId；取不到时用最后一次聚焦窗口（captureVisibleTab 必须有 windowId）
      let winId = sender.tab && sender.tab.windowId;
      const grab = (id) => {
        const opts = { format: 'png' };
        const cb = (dataUrl) => {
          if (chrome.runtime.lastError) sendResponse({ dataUrl: null, error: chrome.runtime.lastError.message });
          else sendResponse({ dataUrl: dataUrl || null });
        };
        if (id != null) chrome.tabs.captureVisibleTab(id, opts, cb);
        else chrome.tabs.captureVisibleTab(opts, cb);
      };
      if (winId != null) grab(winId);
      else chrome.windows.getLastFocused({}, (w) => grab(w && w.id));
    } catch (e) {
      sendResponse({ dataUrl: null, error: String((e && e.message) || e) });
    }
    return true; // 异步响应
  }

  return undefined;
});
