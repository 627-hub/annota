/**
 * Annota 设计系统 tokens（与 product-spec.md §5.3 对齐）。
 * 页面态用 public/tokens.css；注入态用本文件的 VA_TOKENS_CSS。
 */
(function () {
  const TOKENS_CSS = `
:host, :root {
  --va-accent: #F5A623;
  --va-word: #F5A623;
  --va-comment: #38BDF8;
  --va-question: #A78BFA;
  --va-ai-suggest: rgba(255, 255, 255, 0.55);
  --va-glass-bg: rgba(17, 19, 23, 0.78);
  --va-glass-border: 1px solid rgba(255, 255, 255, 0.08);
  --va-glass-blur: blur(20px) saturate(160%);
  --va-glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  --va-text: #F4F5F7;
  --va-text-secondary: #A6ACB5;
  --va-text-muted: #6E747D;
  --va-success: #34C77B;
  --va-warning: #F5484D;
  --va-info: #3E82F7;
  --va-font-ui: -apple-system, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  --va-font-mono: ui-monospace, "SF Mono", "JetBrains Mono", monospace;
  --va-text-xs: 12px;
  --va-text-sm: 13px;
  --va-text-base: 14px;
  --va-text-md: 16px;
  --va-text-lg: 20px;
  --va-text-xl: 24px;
  --va-line-height: 1.5;
  --va-line-height-cjk: 1.6;
  --va-space-1: 4px;
  --va-space-2: 8px;
  --va-space-3: 12px;
  --va-space-4: 16px;
  --va-space-5: 20px;
  --va-space-6: 24px;
  --va-radius-sm: 8px;
  --va-radius-md: 12px;
  --va-radius-lg: 16px;
  --va-radius-pill: 999px;
  --va-duration-fast: 120ms;
  --va-duration-base: 200ms;
  --va-duration-slow: 240ms;
  --va-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --va-z-marks: 1;
  --va-z-dock: 2;
  --va-z-panel: 3;
  --va-z-editor: 4;
  --va-z-toast: 5;
}
.va-glass {
  background: var(--va-glass-bg);
  backdrop-filter: var(--va-glass-blur);
  -webkit-backdrop-filter: var(--va-glass-blur);
  border: var(--va-glass-border);
  box-shadow: var(--va-glass-shadow);
}
.va-text-secondary { color: var(--va-text-secondary); }
.va-text-muted { color: var(--va-text-muted); }
.va-mono { font-family: var(--va-font-mono); }
`;

  const TOKENS = {
    accent: '#F5A623',
    word: '#F5A623',
    comment: '#38BDF8',
    question: '#A78BFA',
    aiSuggest: 'rgba(255,255,255,0.55)',
    glassBg: 'rgba(17,19,23,0.78)',
    glassBorder: '1px solid rgba(255,255,255,0.08)',
    glassBlur: 'blur(20px) saturate(160%)',
    glassShadow: '0 8px 32px rgba(0,0,0,0.4)',
    text: '#F4F5F7',
    textSecondary: '#A6ACB5',
    textMuted: '#6E747D',
    success: '#34C77B',
    warning: '#F5484D',
    info: '#3E82F7',
    fontUi: '-apple-system, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif',
    fontMono: 'ui-monospace, "SF Mono", "JetBrains Mono", monospace',
    space: [4, 8, 12, 16, 20, 24],
    radius: { sm: '8px', md: '12px', lg: '16px', pill: '999px' },
    duration: { fast: 120, base: 200, slow: 240 },
    ease: 'cubic-bezier(0.2,0.8,0.2,1)',
    z: { marks: 1, dock: 2, panel: 3, editor: 4, toast: 5 }
  };

  // 暴露给全局，供 src/core.js 在 Shadow DOM / 页面 head 中注入
  window.VA_TOKENS_CSS = TOKENS_CSS;
  window.VA_TOKENS = TOKENS;
})();
