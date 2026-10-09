#!/usr/bin/env node
// R2：版本号单一来源校验——Cargo.toml 与 tauri.conf.json 必须一致（tag/CI 用）。
// userscript 的 VERSION 计数器是独立递增序列，不参与本校验。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cargo = readFileSync(resolve(root, 'app/annota/Cargo.toml'), 'utf8');
const tauriRaw = readFileSync(resolve(root, 'app/annota/tauri.conf.json'), 'utf8');

const cargoVer = (cargo.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
// tauri.conf.json 是严格 JSON；直接解析（若未来改 jsonc 再放宽）
let tauriVer;
try {
  tauriVer = JSON.parse(tauriRaw).version;
} catch {
  tauriVer = (tauriRaw.match(/"version"\s*:\s*"([^"]+)"/) || [])[1];
}

if (!cargoVer || !tauriVer) {
  console.error(`# FAIL 无法解析版本：Cargo.toml=${cargoVer} tauri.conf.json=${tauriVer}`);
  process.exit(1);
}
if (cargoVer !== tauriVer) {
  console.error(`# FAIL 版本不一致：Cargo.toml=${cargoVer} ≠ tauri.conf.json=${tauriVer}`);
  process.exit(1);
}
console.log(`# PASS 版本一致：${cargoVer}`);
