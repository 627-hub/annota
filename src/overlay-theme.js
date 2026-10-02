/* Annota injected UI theme (R1: GlassDock + EditorCard + SidePanel + Onboarding).
 * Loaded after design-tokens.js and before core.js. */
(function () {
  'use strict';
  window.VA_OVERLAY_CSS = (window.VA_TOKENS_CSS || '') + `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
button, input, select { font: inherit; }
button { color: inherit; }
.va-ui-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  isolation: isolate;
  color: var(--va-text);
  font: 13px/1.45 var(--va-font-ui);
  -webkit-font-smoothing: antialiased;
}
.va-ui-root[data-ui-hidden="1"] .va-panel { visibility: hidden; }

/* ---------- GlassDock（C1） ---------- */
.va-dock {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2147483002;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 48px;
  padding: 4px;
  pointer-events: auto;
  border: 1px solid rgba(255,255,255,.105);
  border-radius: 999px;
  background: rgba(16,18,22,.84);
  -webkit-backdrop-filter: blur(22px) saturate(145%);
  backdrop-filter: blur(22px) saturate(145%);
  box-shadow: 0 14px 42px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.055);
  transition: height var(--va-duration-base) var(--va-ease), border-radius var(--va-duration-base) var(--va-ease), transform var(--va-duration-base) var(--va-ease), opacity var(--va-duration-base) var(--va-ease);
}
.va-dock[data-side="left"] { right: auto; left: 24px; }
.va-dock[data-grow="1"] { animation: va-dock-grow 520ms var(--va-ease) both; }
.va-dock-fab {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: none;
  border: 1px solid rgba(245,166,35,.3);
  border-radius: 50%;
  background: rgba(245,166,35,.12);
  color: var(--va-accent);
  cursor: pointer;
  transition: background var(--va-duration-fast) ease, transform var(--va-duration-fast) ease;
}
.va-dock-fab:hover { background: rgba(245,166,35,.2); }
.va-dock-fab:active { transform: scale(.94); }
.va-dock-fab svg { width: 20px; height: 20px; }
.va-dock-fab.is-breathing { animation: va-breathe 2.6s ease-in-out infinite; }
/* 收起态只露圆钮；hover / 点开 / 键盘聚焦时展开 */
.va-dock > .va-action, .va-dock > .va-sync-badge { display: none; }
.va-dock:hover, .va-dock[data-open="1"], .va-dock:focus-within { height: 56px; padding: 6px 8px; border-radius: 20px; }
.va-dock:hover > .va-dock-fab, .va-dock[data-open="1"] > .va-dock-fab, .va-dock:focus-within > .va-dock-fab { display: none; }
.va-dock:hover > .va-action, .va-dock[data-open="1"] > .va-action, .va-dock:focus-within > .va-action { display: inline-flex; }
.va-dock:hover > .va-sync-badge, .va-dock[data-open="1"] > .va-sync-badge, .va-dock:focus-within > .va-sync-badge { display: grid; }
.va-action {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 38px;
  min-width: 38px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: #c6cbd2;
  font-size: 12px;
  font-weight: 560;
  white-space: nowrap;
  cursor: pointer;
  pointer-events: auto;
  transition: background var(--va-duration-fast) var(--va-ease), color var(--va-duration-fast) var(--va-ease), border-color var(--va-duration-fast) var(--va-ease), transform var(--va-duration-fast) var(--va-ease);
}
.va-action:hover { background: rgba(255,255,255,.075); color: #fff; }
.va-action:active { transform: scale(.96); }
.va-action svg { width: 17px; height: 17px; flex: none; }
.va-action.is-active {
  border-color: rgba(245,166,35,.24);
  background: rgba(245,166,35,.13);
  color: #ffd18a;
}
.va-action-chev { padding: 0 5px; }
.va-action-chev svg { width: 13px; height: 13px; }
.va-action-primary {
  padding: 0 13px;
  border-color: rgba(255,214,148,.34);
  background: var(--va-accent);
  color: #241707;
  font-weight: 700;
  box-shadow: 0 2px 9px rgba(245,166,35,.18), inset 0 1px rgba(255,255,255,.3);
}
.va-action-primary:hover { background: #ffb842; color: #211506; }
/* 同步状态徽标：badge / spinner / ✓ 淡出 */
.va-sync-badge {
  position: absolute;
  top: -5px;
  right: -3px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  place-items: center;
  border-radius: 999px;
  background: var(--va-accent);
  color: #241707;
  font: 700 9px/17px var(--va-font-mono);
  text-align: center;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
  pointer-events: none;
}
.va-action.is-busy svg { animation: va-spin 900ms linear infinite; }
.va-action.is-done { border-color: rgba(52,199,123,.5); color: #7fe0ae; }
.va-action.is-done::after { content: '\\2713'; position: absolute; top: -7px; right: -1px; font: 700 10px var(--va-font-ui); color: var(--va-success); animation: va-fade-check 800ms ease forwards; }

/* ---------- 分组 popover 菜单 ---------- */
.va-popover.va-menu-pop { width: 216px; padding: 7px; display: flex; flex-direction: column; gap: 2px; }
.va-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #c7cbd1;
  font: 550 11px var(--va-font-ui);
  cursor: pointer;
  text-align: left;
}
.va-menu-item:hover { background: rgba(255,255,255,.075); color: #fff; }
.va-menu-item small { color: #717985; font-size: 9px; font-weight: 450; }
.va-menu-item .va-check { color: var(--va-accent); font-weight: 700; }
.va-menu-sep { height: 1px; margin: 4px 3px; background: rgba(255,255,255,.08); }
.va-menu-title { padding: 6px 9px 5px; color: #737b85; font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.va-menu-pop > .va-btn { justify-content: flex-start; width: 100%; padding-left: 10px; }
.va-menu-row { display: flex; gap: 5px; margin-top: 5px; }
.va-menu-row > .va-btn { min-width: 0; flex: 1; padding: 0 5px; font-size: 10px; }

/* ---------- 标注框（§6.1） ---------- */
.va-mark { border:1.5px solid var(--va-word); border-radius:5px; background:rgba(245,166,35,.105); pointer-events:auto; cursor:pointer; transition:background 120ms ease, box-shadow 120ms ease; }
.va-mark:hover { background:rgba(245,166,35,.19); box-shadow:0 0 0 2px rgba(245,166,35,.12); }
.va-mark.is-hl { background:rgba(245,166,35,.28); box-shadow:0 0 0 3px rgba(245,166,35,.2); }
.va-mark.is-flash { animation: va-flash 160ms ease; }
.va-mark-label { position:absolute; left:-1px; top:-24px; display:inline-flex; align-items:center; gap:5px; max-width:min(240px,70vw); overflow:hidden; padding:3px 8px; border:1px solid rgba(245,166,35,.28); border-radius:8px; background:rgba(18,20,24,.94); color:#f3d4a2; font:600 10px/1.35 var(--va-font-ui); text-overflow:ellipsis; white-space:nowrap; box-shadow:0 4px 12px rgba(0,0,0,.22); }
.va-mark-label::before { content:""; width:5px; height:5px; flex:none; border-radius:50%; background:var(--va-word); }
.va-draft-mark { border:1.5px dashed #f5a623; border-radius:5px; background:rgba(245,166,35,.12); box-shadow:0 0 0 3px rgba(245,166,35,.06); }

/* ---------- SidePanel（C4） ---------- */
.va-panel {
  position: fixed;
  top: 16px;
  right: 16px;
  bottom: 88px;
  z-index: 2147483003;
  display: flex;
  flex-direction: column;
  width: min(360px, calc(100vw - 24px));
  overflow: hidden;
  pointer-events: auto;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 20px;
  background: rgba(17,19,23,.965);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
  backdrop-filter: blur(24px) saturate(150%);
  box-shadow: 0 22px 70px rgba(0,0,0,.48), inset 0 1px rgba(255,255,255,.045);
  transform: translateX(calc(100% + 28px));
  opacity: 0;
  visibility: hidden;
  transition: transform 230ms var(--va-ease), opacity 180ms ease, visibility 230ms;
}
.va-panel.is-open { transform: translateX(0); opacity: 1; visibility: visible; }
.va-panel-head { display:flex; align-items:center; gap:12px; padding:18px 18px 13px; border-bottom:1px solid rgba(255,255,255,.075); }
.va-panel-title { min-width:0; flex:1; }
.va-panel-title strong { display:block; font-size:15px; font-weight:650; letter-spacing:-.02em; }
.va-panel-title span { display:block; overflow:hidden; margin-top:3px; color:var(--va-text-muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.va-close {
  display:grid; place-items:center; width:32px; height:32px; border:0; border-radius:10px;
  background:rgba(255,255,255,.055); color:#abb2bb; cursor:pointer;
}
.va-close:hover { background:rgba(255,255,255,.11); color:white; }
.va-close svg, .va-entry-more svg, .va-probe svg { width:15px; height:15px; flex:none; }
.va-panel-tabs { display:flex; gap:4px; padding:12px 16px 8px; }
.va-tab { padding:7px 11px; border:1px solid transparent; border-radius:9px; background:transparent; color:#858c96; font-size:11px; cursor:pointer; }
.va-tab:hover { color:#d4d7dc; background:rgba(255,255,255,.04); }
.va-tab.is-active { color:#ffd18a; border-color:rgba(245,166,35,.2); background:rgba(245,166,35,.1); }
.va-panel-search { padding:4px 16px 12px; }
.va-panel-tools { display:flex; gap:6px; padding:0 16px 10px; }
.va-panel-tools .va-btn { flex:1; min-height:30px; }
.va-input, .va-select {
  width:100%; min-width:0; height:38px; padding:0 11px; border:1px solid rgba(255,255,255,.105); border-radius:10px;
  background:rgba(255,255,255,.045); color:var(--va-text); font:13px var(--va-font-ui); outline:none;
}
.va-input::placeholder { color:#69717b; }
.va-input:focus, .va-select:focus { border-color:rgba(245,166,35,.65); box-shadow:0 0 0 3px rgba(245,166,35,.1); }
.va-input-mono { font-family: var(--va-font-mono); font-size: 12px; }
.va-entry-list { flex:1; min-height:0; overflow:auto; padding:0 10px 14px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.16) transparent; }
.va-entry-group { padding:8px 8px 4px; color:#717985; font-size:10px; font-weight:650; letter-spacing:.08em; text-transform:uppercase; }
.va-entry-row {
  display:flex; align-items:center; gap:10px; width:100%; min-height:56px; padding:9px 10px; border:1px solid transparent;
  border-radius:12px; background:transparent; color:var(--va-text); text-align:left; cursor:pointer;
  transition:background var(--va-duration-fast) ease, border-color var(--va-duration-fast) ease;
}
.va-entry-row:hover { border-color:rgba(255,255,255,.075); background:rgba(255,255,255,.045); }
.va-entry-idx { display:grid; place-items:center; min-width:23px; height:23px; padding:0 3px; flex:none; border:1px solid rgba(255,255,255,.12); border-radius:7px; color:#89919b; font:600 9px var(--va-font-mono); transition:all 120ms ease; }
.va-entry-row:hover .va-entry-idx { color:#ffd18a; border-color:rgba(245,166,35,.35); background:rgba(245,166,35,.08); }
.va-entry-code { flex:none; padding:3px 6px; border:1px solid rgba(245,166,35,.14); border-radius:7px; background:rgba(245,166,35,.06); color:#eab76b; font:10px var(--va-font-mono); }
.va-entry-copy { min-width:0; flex:1; }
.va-entry-copy strong { display:block; overflow:hidden; font-size:13px; font-weight:620; text-overflow:ellipsis; white-space:nowrap; }
.va-entry-copy span { display:block; overflow:hidden; margin-top:3px; color:#89919b; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.va-entry-more { display:grid; place-items:center; width:28px; height:28px; flex:none; border:0; border-radius:8px; background:transparent; color:#7d8590; cursor:pointer; }
.va-entry-more:hover { background:rgba(255,255,255,.08); color:white; }
.va-empty { display:grid; place-items:center; min-height:180px; padding:24px; color:#9299a3; text-align:center; align-content:center; }
.va-empty-mark { display:grid; place-items:center; width:40px; height:40px; margin-bottom:12px; border:1px solid rgba(245,166,35,.2); border-radius:13px; background:rgba(245,166,35,.08); color:var(--va-accent); }
.va-empty strong { display:block; color:#d9dce1; font-size:13px; font-weight:600; }
.va-empty span { display:block; max-width:230px; margin-top:5px; color:#7d8590; font-size:11px; line-height:1.5; }
.va-empty-action { margin-top:14px; pointer-events:auto; }
.va-panel-foot { padding:12px 18px; border-top:1px solid rgba(255,255,255,.07); color:#77808b; font-size:10px; }
.va-src-row { display:flex; align-items:center; gap:8px; margin:4px 0; padding:10px 12px; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(255,255,255,.03); font-size:12px; }
.va-src-name { font-weight:620; }
.va-src-tag { padding:2px 7px; border-radius:999px; background:rgba(245,166,35,.12); color:#ffd18a; font-size:9px; }
.va-src-count { margin-left:auto; color:#89919b; font-size:10px; }
.va-src-note { margin:10px 2px 0; padding:10px 12px; border:1px dashed rgba(255,255,255,.1); border-radius:10px; color:#7d8590; font-size:10px; line-height:1.55; }
.va-assistant { display:none; flex:1; min-height:0; flex-direction:column; }
.va-assistant-notice { flex:none; color:#e9c98f; font-size:10px; line-height:1.5; }
.va-assistant-notice:empty { display:none; }
.va-assistant-notice[data-state="error"] { margin:0 15px 8px; padding:9px 11px; border:1px solid rgba(240,113,120,.25); border-radius:10px; background:rgba(240,113,120,.07); color:#ffc6c9; }
.va-chat-transcript { display:flex; flex:1; min-height:0; flex-direction:column; gap:9px; overflow:auto; padding:4px 14px 14px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.16) transparent; }
.va-chat-message { max-width:92%; padding:10px 12px; border:1px solid rgba(255,255,255,.075); border-radius:13px; background:rgba(255,255,255,.035); }
.va-chat-user { align-self:flex-end; border-color:rgba(245,166,35,.2); background:rgba(245,166,35,.085); }
.va-chat-assistant, .va-chat-notice { align-self:flex-start; }
.va-chat-role { display:block; margin-bottom:4px; color:#b08b56; font-size:9px; font-weight:700; letter-spacing:.06em; }
.va-chat-copy { margin:0; color:#e1e2e5; font-size:12px; line-height:1.6; overflow-wrap:anywhere; white-space:pre-wrap; }
.va-chat-form { display:flex; flex:none; align-items:flex-end; gap:8px; padding:11px 13px 13px; border-top:1px solid rgba(255,255,255,.075); background:rgba(12,14,17,.45); }
.va-chat-input { flex:1; min-width:0; min-height:42px; max-height:120px; resize:vertical; padding:10px 11px; border:1px solid rgba(255,255,255,.105); border-radius:11px; outline:none; background:rgba(255,255,255,.045); color:var(--va-text); font:12px/1.45 var(--va-font-ui); }
.va-chat-input::placeholder { color:#69717b; }
.va-chat-input:focus { border-color:rgba(245,166,35,.65); box-shadow:0 0 0 3px rgba(245,166,35,.1); }
.va-chat-form .va-btn { min-height:38px; flex:none; }
.va-chat-form .va-btn:disabled, .va-audit-actions .va-btn:disabled { opacity:.55; cursor:wait; }
.va-audit-card { flex:none; padding:10px 11px; border:1px solid rgba(245,166,35,.2); border-radius:12px; background:rgba(245,166,35,.045); color:#d5d8dc; font-size:10px; }
.va-audit-card summary { display:flex; align-items:center; justify-content:space-between; gap:8px; cursor:pointer; list-style:none; }
.va-audit-card summary::-webkit-details-marker { display:none; }
.va-audit-card summary strong { color:#f0d2a0; font-size:11px; }
.va-audit-state { color:#8f98a3; font-size:9px; }
.va-audit-label, .va-audit-card > span { display:block; margin:10px 0 4px; color:#8b929c; font-size:9px; font-weight:650; }
.va-audit-data { max-height:150px; overflow:auto; margin:0; padding:8px; border:1px solid rgba(255,255,255,.06); border-radius:8px; background:rgba(0,0,0,.18); color:#b7c0ca; font:9px/1.5 var(--va-font-mono); white-space:pre-wrap; overflow-wrap:anywhere; }
.va-audit-actions { display:flex; justify-content:flex-end; gap:6px; margin-top:9px; }
.va-audit-actions .va-btn { min-height:29px; }
.va-audit-actions .va-btn-danger { color:#f2a2a5; }
.va-audit-card summary:focus-visible, .va-audit-actions .va-btn:focus-visible {
  outline:2px solid var(--va-accent);
  outline-offset:2px;
}

/* ---------- EditorCard / WordCard（C3/C6，根节点统一 .va-popover） ---------- */
.va-popover {
  position:fixed; z-index:2147483004; width:min(304px,calc(100vw - 24px)); max-height:calc(100vh - 24px); overflow:auto;
  padding:17px; border:1px solid rgba(255,255,255,.13); border-radius:17px; background:rgba(19,21,25,.975);
  color:var(--va-text); box-shadow:0 24px 70px rgba(0,0,0,.56), inset 0 1px rgba(255,255,255,.045);
  -webkit-backdrop-filter:blur(24px) saturate(140%); backdrop-filter:blur(24px) saturate(140%);
  pointer-events:auto; animation:va-pop-in 150ms var(--va-ease) both;
}
.va-popover[data-ai="1"] { border-style:dashed; border-color:rgba(245,166,35,.58); box-shadow:0 24px 70px rgba(0,0,0,.56), 0 0 0 3px rgba(245,166,35,.06); }
@keyframes va-pop-in { from { opacity:0; transform:translateY(5px) scale(.985); } to { opacity:1; transform:translateY(0) scale(1); } }
.va-pop-head { display:flex; align-items:flex-start; gap:12px; margin-bottom:15px; }
.va-pop-heading { min-width:0; flex:1; }
.va-eyebrow { margin-bottom:5px; color:#9b8260; font-size:9px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
.va-pop-heading strong { display:block; font-size:15px; font-weight:650; letter-spacing:-.02em; }
.va-pop-heading span { display:block; margin-top:3px; color:#7f8792; font-size:11px; }
.va-field-label { display:block; margin:12px 0 6px; color:#9da4ad; font-size:10px; font-weight:620; }
.va-time-row { display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; }
.va-duration { display:flex; gap:5px; margin-top:7px; }
.va-chip { height:26px; padding:0 9px; border:1px solid rgba(255,255,255,.1); border-radius:8px; background:rgba(255,255,255,.035); color:#aeb4bc; font-size:10px; cursor:pointer; }
.va-chip:hover { border-color:rgba(245,166,35,.4); color:#ffd18a; }
.va-chip.is-active { border-color:rgba(245,166,35,.38); background:rgba(245,166,35,.12); color:#ffd18a; }
.va-dur-row { display:flex; align-items:center; gap:6px; margin-top:7px; }
.va-dur-row .va-input { width:64px; height:28px; padding:0 8px; font-family:var(--va-font-mono); font-size:11px; }
.va-scrub { position:relative; height:20px; margin:10px 0 2px; cursor:pointer; touch-action:none; }
.va-scrub::before { content:''; position:absolute; left:0; right:0; top:9px; height:2px; border-radius:2px; background:rgba(255,255,255,.14); }
.va-scrub-fill { position:absolute; left:0; top:9px; height:2px; border-radius:2px; background:var(--va-accent); }
.va-scrub-thumb { position:absolute; top:5px; left:0; width:10px; height:10px; margin-left:-5px; border-radius:50%; background:var(--va-accent); box-shadow:0 0 0 3px rgba(245,166,35,.22); }
.va-editor-hint { display:flex; align-items:center; gap:7px; margin:0 0 10px; padding:7px 10px; border:1px dashed rgba(245,166,35,.4); border-radius:10px; background:rgba(245,166,35,.08); color:#f0d2a0; font-size:11px; }
.va-editor-hint svg { width:13px; height:13px; flex:none; color:var(--va-accent); }
.va-dictionary { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:12px; padding-top:11px; border-top:1px solid rgba(255,255,255,.07); }
.va-dictionary-label { margin-right:2px; color:#737b85; font-size:10px; }
.va-dictionary a { color:#c4a36f; font-size:10px; text-decoration:none; }
.va-dictionary a:hover { color:#ffd18a; text-decoration:underline; }
.va-pop-actions { display:flex; justify-content:flex-end; gap:7px; margin-top:16px; }
.va-range { margin:0 0 4px; color:#bf9a62; font:10px var(--va-font-mono); }
.va-btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:34px; padding:0 11px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(255,255,255,.055); color:#c7cbd1; font:550 11px var(--va-font-ui); cursor:pointer; transition:all 120ms ease; }
.va-btn:hover { border-color:rgba(255,255,255,.18); background:rgba(255,255,255,.095); color:#fff; }
.va-btn-primary { border-color:rgba(255,214,148,.32); background:var(--va-accent); color:#241707; font-weight:700; }
.va-btn-primary:hover { border-color:#ffc66a; background:#ffb842; color:#211506; }
.va-btn-danger { color:#ed9298; }

/* ---------- Onboarding 气泡（C8） ---------- */
.va-onb {
  position:fixed; z-index:2147483006; width:250px; padding:12px 13px 10px;
  border:1px solid rgba(245,166,35,.3); border-radius:14px; background:rgba(19,21,25,.97);
  box-shadow:0 18px 50px rgba(0,0,0,.5), 0 0 0 3px rgba(245,166,35,.05);
  pointer-events:auto; animation:va-pop-in 180ms var(--va-ease) both;
}
.va-onb::before { content:''; position:absolute; left:28px; bottom:-6px; width:10px; height:10px; transform:rotate(45deg); border-right:1px solid rgba(245,166,35,.3); border-bottom:1px solid rgba(245,166,35,.3); background:rgba(19,21,25,.97); }
.va-onb-text { color:#e8e2d6; font-size:11px; line-height:1.55; }
.va-onb-row { display:flex; justify-content:flex-end; gap:6px; margin-top:9px; }
.va-onb-ok { min-height:26px; padding:0 10px; border:1px solid rgba(255,214,148,.32); border-radius:8px; background:var(--va-accent); color:#241707; font:700 10px var(--va-font-ui); cursor:pointer; }
.va-onb-skip { min-height:26px; padding:0 10px; border:1px solid transparent; border-radius:8px; background:transparent; color:#8b939d; font:10px var(--va-font-ui); cursor:pointer; }
.va-onb-skip:hover { color:#d4d7dc; }

/* ---------- 反馈件 ---------- */
.va-toast { position:fixed; left:50%; bottom:94px; z-index:2147483005; max-width:min(520px,calc(100vw - 28px)); padding:10px 15px; border:1px solid rgba(255,255,255,.12); border-radius:12px; background:rgba(18,20,24,.96); color:#e8e9ec; font:12px/1.45 var(--va-font-ui); box-shadow:0 10px 35px rgba(0,0,0,.42); transform:translate(-50%,8px); opacity:0; transition:opacity 150ms ease, transform 150ms var(--va-ease); pointer-events:none; }
.va-toast.is-visible { opacity:1; transform:translate(-50%,0); }
.va-toast.is-error { border-color:rgba(240,113,120,.42); color:#ffd1d3; }
.va-diag { position:fixed; right:22px; bottom:86px; z-index:2147483004; width:min(560px,calc(100vw - 24px)); max-height:58vh; overflow:auto; margin:0; padding:15px; border:1px solid rgba(255,255,255,.11); border-radius:14px; background:rgba(12,14,17,.975); color:#a7c6e8; font:11px/1.6 var(--va-font-mono); white-space:pre-wrap; box-shadow:0 20px 60px rgba(0,0,0,.5); pointer-events:auto; }
.va-probe { position:fixed; right:22px; bottom:22px; z-index:2147483001; display:flex; align-items:center; gap:8px; padding:10px 13px; border:1px solid rgba(245,166,35,.24); border-radius:12px; background:rgba(17,19,23,.94); color:#f0d2a0; font:11px var(--va-font-ui); box-shadow:0 10px 30px rgba(0,0,0,.4); cursor:pointer; pointer-events:auto; }
.va-probe:hover { border-color:rgba(245,166,35,.5); }

/* ---------- 动效 ---------- */
@keyframes va-dock-grow { 0% { opacity:0; transform:scale(.2); } 60% { opacity:1; transform:scale(1.06); } 100% { opacity:1; transform:scale(1); } }
@keyframes va-breathe { 0%,100% { box-shadow:0 0 0 0 rgba(245,166,35,.38); } 50% { box-shadow:0 0 0 9px rgba(245,166,35,0); } }
@keyframes va-spin { to { transform:rotate(360deg); } }
@keyframes va-fade-check { 0% { opacity:1; transform:translateY(0); } 100% { opacity:0; transform:translateY(-6px); } }
@keyframes va-flash { 0% { box-shadow:0 0 0 0 rgba(245,166,35,.7); } 100% { box-shadow:0 0 0 12px rgba(245,166,35,0); } }

.va-reduced-motion *, .va-reduced-motion *::before, .va-reduced-motion *::after { animation-duration:.01ms !important; transition-duration:.01ms !important; }
.va-action:focus-visible, .va-btn:focus-visible, .va-input:focus-visible, .va-select:focus-visible, .va-menu-item:focus-visible, .va-dock-fab:focus-visible, .va-chip:focus-visible, .va-entry-row:focus-visible, .va-onb-ok:focus-visible, .va-onb-skip:focus-visible, .va-tab:focus-visible {
  outline: 2px solid var(--va-accent);
  outline-offset: 2px;
}
.va-chat-input:focus-visible { outline:2px solid var(--va-accent); outline-offset:2px; }
@media (max-width: 768px) {
  .va-dock { right:12px; bottom:12px; }
  .va-dock[data-side="left"] { left:12px; }
  .va-action { width:38px; padding:0; justify-content:center; }
  .va-action-label { display:none; }
  .va-action-primary { width:auto; padding:0 11px; }
  .va-panel { top:auto; right:8px; bottom:8px; left:8px; width:auto; height:70vh; border-radius:18px; transform:translateY(calc(100% + 24px)); }
  .va-panel.is-open { transform:translateY(0); }
  .va-popover { left:12px !important; right:12px; bottom:76px; top:auto !important; width:auto; }
  .va-onb { width:calc(100vw - 24px); }
  .va-probe { right:10px; bottom:10px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior:auto !important; animation-duration:.01ms !important; transition-duration:.01ms !important; }
}
`;
})();
