/* video-annotate · i18n（用户可见字符串本地化）
 * locale 文件与前端共用 public/i18n 下的 zh-CN.json / en.json（编译期 include_str! 打包，无运行时文件依赖）。
 * key 缺失时回退 zh-CN，再缺失返回 key 本身（永不 panic）。
 *
 * locale 解析顺序（进程级缓存，首次 t() 调用时定格）：
 *   1. env ANNOTA_LOCALE（显式覆盖，测试/开发用）
 *   2. 系统 locale（sys-locale，跨平台；zh* → zh-CN，en* → en，其余 → zh-CN）
 *   3. 默认 zh-CN
 *
 * 用法：
 *   crate::i18n::t("err.tab_not_found")                       → 取整串
 *   crate::i18n::tf("err.tab_missing", &[("id", &id)])        → {id} 占位替换
 */
use std::collections::HashMap;
use std::sync::OnceLock;

const ZH_JSON: &str = include_str!("../public/i18n/zh-CN.json");
const EN_JSON: &str = include_str!("../public/i18n/en.json");

fn parse(s: &str) -> HashMap<String, String> {
    serde_json::from_str::<HashMap<String, String>>(s).unwrap_or_default()
}

fn zh() -> &'static HashMap<String, String> {
    static M: OnceLock<HashMap<String, String>> = OnceLock::new();
    M.get_or_init(|| parse(ZH_JSON))
}

fn en() -> &'static HashMap<String, String> {
    static M: OnceLock<HashMap<String, String>> = OnceLock::new();
    M.get_or_init(|| parse(EN_JSON))
}

/// 规范化 locale 标签：只要语言前缀（zh/en），保留完整标签用于匹配。
fn normalize(lang: &str) -> String {
    let l = lang.trim().to_ascii_lowercase();
    if l.starts_with("zh") { "zh-CN".to_string() }
    else if l.starts_with("en") { "en".to_string() }
    else { "zh-CN".to_string() }
}

fn detect() -> String {
    if let Ok(v) = std::env::var("ANNOTA_LOCALE") {
        if !v.trim().is_empty() {
            return normalize(&v);
        }
    }
    if let Some(l) = sys_locale::get_locale() {
        return normalize(&l);
    }
    "zh-CN".to_string()
}

fn locale() -> &'static str {
    static L: OnceLock<String> = OnceLock::new();
    L.get_or_init(detect)
}

fn lookup(lang: &str, key: &str) -> Option<String> {
    if lang == "en" {
        if let Some(v) = en().get(key) {
            return Some(v.clone());
        }
    }
    zh().get(key).cloned()
}

/// 取本地化字符串。key 缺失时回退 zh-CN，再缺失返回 key 本身。
pub fn t(key: &str) -> String {
    lookup(locale(), key).unwrap_or_else(|| key.to_string())
}

/// 带 {name} 占位替换的本地化。
pub fn tf(key: &str, params: &[(&str, &str)]) -> String {
    let mut s = t(key);
    for (k, v) in params {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zh_fallback_chain() {
        // zh 默认 locale 下：zh 有该 key
        assert_eq!(lookup("zh-CN", "retry"), Some("重试".to_string()));
        // en 有该 key
        assert_eq!(lookup("en", "retry"), Some("Retry".to_string()));
        // key 缺失 → None（t() 再兜底为 key 本身）
        assert_eq!(lookup("en", "no.such.key"), None);
        assert_eq!(lookup("zh-CN", "no.such.key"), None);
    }

    #[test]
    fn t_never_panics_on_missing_key() {
        assert_eq!(t("no.such.key"), "no.such.key");
    }

    #[test]
    fn tf_replaces_placeholders() {
        // update_title 两端都有 {v}
        let zh = tf("update_title", &[("v", "9.9.9")]);
        assert!(zh.contains("9.9.9"), "zh update_title 应含插值: {zh}");
        assert!(!zh.contains("{v}"), "占位符应被替换: {zh}");
        let en = {
            let s = lookup("en", "update_title").unwrap();
            let mut s = s;
            s = s.replace("{v}", "9.9.9");
            assert!(!s.contains("{v}"));
            s
        };
        assert!(en.contains("9.9.9"));
    }

    #[test]
    fn locale_json_parses_and_has_core_keys() {
        // 保证 include 的 JSON 可解析且两端 key 集合一致
        let zh_keys: std::collections::HashSet<_> = zh().keys().collect();
        let en_keys: std::collections::HashSet<_> = en().keys().collect();
        assert!(!zh_keys.is_empty(), "zh locale 不应为空");
        assert_eq!(zh_keys, en_keys, "zh/en key 集合必须一致");
    }

    #[test]
    fn normalize_locale_tags() {
        assert_eq!(normalize("zh-CN"), "zh-CN");
        assert_eq!(normalize("zh_TW"), "zh-CN");
        assert_eq!(normalize("en-US"), "en");
        assert_eq!(normalize("en"), "en");
        assert_eq!(normalize("ja-JP"), "zh-CN"); // 未支持语言回退中文
    }
}
