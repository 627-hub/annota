(function () {
  'use strict';
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

  // 与 Rust i18n::normalize() 一致：zh*/en* 前缀归一，其余回退 zh-CN
  function normalize(lang) {
    var l = String(lang || '').trim().toLowerCase();
    if (l.indexOf('zh') === 0) return 'zh-CN';
    if (l.indexOf('en') === 0) return 'en';
    return DEFAULT;
  }

  function detectLocale() {
    try {
      var saved = localStorage.getItem('annota-locale');
      if (saved) return normalize(saved);
    } catch (e) {}
    var nav = navigator.language || navigator.userLanguage || '';
    return normalize(nav);
  }

  function localeUrl(lang) {
    var base = (window.__ANNOTA_LOCALE_BASE__ || '').replace(/\/$/, '');
    return (base ? base + '/' : '') + 'i18n/' + lang + '.json';
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
      if (xhr.status < 200 || xhr.status >= 300) {
        console.warn('[annota] locale load failed: ' + localeUrl(lang) + ' HTTP ' + xhr.status);
        finish({});
        return;
      }
      var obj = {};
      try { obj = JSON.parse(xhr.responseText); } catch (e) {
        console.warn('[annota] locale parse failed: ' + localeUrl(lang), e);
      }
      finish(obj);
    };
    xhr.onerror = function () { finish({}); };
    xhr.ontimeout = function () { finish({}); };
    xhr.send();
  }

  // 只合并自有可枚举 key（防原型链污染）
  function mergeFallback(strings, fallback) {
    Object.keys(fallback).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(strings, k)) strings[k] = fallback[k];
    });
  }

  window.__i18n = { locale: DEFAULT, strings: {} };

  function loadWithFallback(lang, cb) {
    loadLocale(lang, function (strings) {
      window.__i18n.strings = strings;
      if (lang !== DEFAULT) {
        loadLocale(DEFAULT, function (fallback) {
          mergeFallback(strings, fallback);
          cb();
        });
      } else {
        cb();
      }
    });
  }

  function init(cb) {
    var lang = detectLocale();
    window.__i18n.locale = lang;
    loadWithFallback(lang, cb);
  }

  window.__i18n.init = init;
  window.__i18n.t = function (key, params) {
    var own = Object.prototype.hasOwnProperty.call(window.__i18n.strings, key);
    var s = own ? window.__i18n.strings[key] : key;
    if (params) {
      Object.keys(params).forEach(function (k) {
        s = s.split('{' + k + '}').join(params[k]);
      });
    }
    return s;
  };

  window.__i18n.setLocale = function (lang, cb) {
    lang = normalize(lang);
    try { localStorage.setItem('annota-locale', lang); } catch (e) {}
    window.__i18n.locale = lang;
    loadWithFallback(lang, function () { if (cb) cb(); });
  };
})();
