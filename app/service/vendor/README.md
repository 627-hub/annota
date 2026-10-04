# vendor/ — 第三方浏览器构建（离线自包含）

- `cloudbase.full.js` — `@cloudbase/js-sdk@3.10.1` 的浏览器 IIFE 构建（esbuild 打包），
  暴露全局 `window.cloudbase`（支持 `cloudbase.init(...)` + `app.rdb()` PG 模式）。
  来源：npm `@cloudbase/js-sdk@3.10.1`（原始包无 UMD 单文件，官方 CDN 另发；此处本地等义打包）。
  重建命令：
  ```
  npm i esbuild@0.23.1 @cloudbase/js-sdk@3.10.1
  # entry: import cb from "@cloudbase/js-sdk"; (w=>w.cloudbase=cb.default||cb)(window)
  esbuild entry.js --bundle --format=iife --minify --target=es2019 --outfile=cloudbase.full.js
  ```
  用途：工作区/组页连 CloudBase PG（组共享，R4b）。离线可用，不依赖外网 CDN。
