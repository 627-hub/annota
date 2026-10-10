/* video-annotate · error（结构化应用错误）
 *
 * 设计目标：前端能按稳定 code 分支处理（如 tab_not_found / rate_limited / internal），
 * message 是已本地化的展示文案（i18n key 构造时自动翻译）。
 *
 * 序列化形态（Tauri command 错误 / 本类型直接返回时）：
 *   { "code": "tab_not_found", "message": "标签不存在：tab-3" }
 *
 * HTTP 端向后兼容：json_error 保持 {"error": "<message>"} 并新增 "code" 字段。
 *
 * code 约定：
 * - i18n key（err.* / perm.*）→ 去掉前缀（"err.tab_not_found" → "tab_not_found"）
 * - internal（系统/内部错误，保留原始细节，不本地化）
 * - 前端匹配 code，展示 message；未知 code 按 message 兜底展示。
 */
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    /// 稳定机器可读错误码（前端分支用）
    pub code: String,
    /// 本地化的人类可读消息（展示用）
    pub message: String,
}

fn code_from_key(key: &str) -> String {
    key.strip_prefix("err.")
        .or_else(|| key.strip_prefix("perm."))
        .unwrap_or(key)
        .to_string()
}

impl AppError {
    /// 从 i18n key 构造（code 取 key 去前缀，message 自动本地化）。
    pub fn key(key: &str) -> Self {
        Self {
            code: code_from_key(key),
            message: crate::i18n::t(key),
        }
    }

    /// 带 {param} 占位的 i18n key 构造。
    pub fn keyf(key: &str, params: &[(&str, &str)]) -> Self {
        Self {
            code: code_from_key(key),
            message: crate::i18n::tf(key, params),
        }
    }

    /// 内部/系统错误（不本地化，保留原始细节）。
    pub fn internal(msg: impl std::fmt::Display) -> Self {
        Self {
            code: "internal".into(),
            message: msg.to_string(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

// 迁移期胶水：仍返回 String 的内部函数错误自动升级为 internal（message 保留）。
impl From<String> for AppError {
    fn from(s: String) -> Self {
        Self::internal(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        Self::internal(s.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_strips_prefix_for_code() {
        let e = AppError::key("err.tab_not_found");
        assert_eq!(e.code, "tab_not_found");
        assert!(!e.message.is_empty());
        assert_ne!(e.message, "err.tab_not_found", "message 应本地化而非返回 key");
        let p = AppError::keyf("err.tab_not_found", &[("id", "tab-9")]);
        assert_eq!(p.code, "tab_not_found");
        assert!(p.message.contains("tab-9"), "占位应替换: {}", p.message);
    }

    #[test]
    fn perm_key_maps_to_perm_code() {
        let e = AppError::key("perm.screenshot");
        assert_eq!(e.code, "screenshot");
    }

    #[test]
    fn internal_preserves_detail() {
        let e = AppError::internal("open db: disk full");
        assert_eq!(e.code, "internal");
        assert_eq!(e.message, "open db: disk full");
    }

    #[test]
    fn from_string_becomes_internal() {
        let e: AppError = "boom".to_string().into();
        assert_eq!(e.code, "internal");
        assert_eq!(e.message, "boom");
        // Display 供日志/ahoc 用
        assert_eq!(e.to_string(), "boom");
    }

    #[test]
    fn serializes_as_object_with_code_and_message() {
        let e = AppError::key("err.tab_not_found");
        let v = serde_json::to_value(&e).unwrap();
        assert!(v.get("code").and_then(|c| c.as_str()).is_some());
        assert!(v.get("message").and_then(|m| m.as_str()).is_some());
    }
}
