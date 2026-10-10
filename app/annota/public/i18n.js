(function () {
  var DEFAULT = 'zh-CN';
  var CACHE = {};

  // 兜底：i18n.js 被重复加载或其它异常时，保证 __i18n 始终可用（init 立即回调、t 返回 key）
  if (window.__i18n) return;
  window.__i18n = {
    locale: DEFAULT,
    strings: {},
    init: function (cb) { cb(); },
    t: function (k) { return k; },
    setLocale: function (lang, cb) { if (cb) cb(); }
  };

  function detectLocale() {
    try {
      var saved = localStorage.getItem('annota-locale');
      if (saved) return saved;
    } catch (e) {}
    var nav = navigator.language || navigator.userLanguage || '';
    if (nav.startsWith('zh')) return 'zh-CN';
    if (nav.startsWith('en')) return 'en';
    return DEFAULT;
  }

  function localeUrl(lang) {
    var base = document.baseURI || '';
    if (base.indexOf('127.0.0.1:8793') !== -1 || base.indexOf('localhost:8793') !== -1) {
      return 'http://127.0.0.1:8793/app/annota/public/i18n/' + lang + '.json';
    }
    return 'i18n/' + lang + '.json';
  }

  function loadLocale(lang, cb) {
    if (CACHE[lang]) { cb(CACHE[lang]); return; }
    var done = false;
    var finish = function (obj) { if (done) return; done = true; CACHE[lang] = obj; cb(obj); };
    var xhr = new XMLHttpRequest();
    xhr.open('GET', localeUrl(lang), true);
    // 挂起保护：locale 加载卡住时 3s 内放行（否则 init 回调不触发、页面完全不初始化）
    xhr.timeout = 3000;
    xhr.onload = function () {
      var obj = {};
      try { obj = JSON.parse(xhr.responseText); } catch (e) {}
      finish(obj);
    };
    xhr.onerror = function () { finish({}); };
    xhr.ontimeout = function () { finish({}); };
    xhr.send();
  }

  window.__i18n = { locale: DEFAULT, strings: {} };

  function init(cb) {
    var lang = detectLocale();
    window.__i18n.locale = lang;
    loadLocale(lang, function (strings) {
      window.__i18n.strings = strings;
      if (lang !== DEFAULT) {
        loadLocale(DEFAULT, function (fallback) {
          for (var k in fallback) { if (!(k in strings)) strings[k] = fallback[k]; }
          cb();
        });
      } else {
        cb();
      }
    });
  }

  window.__i18n.init = init;
  window.__i18n.t = function (key, params) {
    var s = window.__i18n.strings[key] || key;
    if (params) {
      for (var k in params) { s = s.split('{' + k + '}').join(params[k]); }
    }
    return s;
  };

  window.__i18n.setLocale = function (lang, cb) {
    try { localStorage.setItem('annota-locale', lang); } catch (e) {}
    window.__i18n.locale = lang;
    loadLocale(lang, function (strings) {
      window.__i18n.strings = strings;
      if (cb) cb();
    });
  };
})();
