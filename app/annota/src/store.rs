/* video-annotate · store（本地持久化，M6）
 * SQLite（rusqlite，bundled）存收藏 / 历史 / 下载记录。
 * 三张表（collectively "browser data"）：
 *   bookmarks(id,url,title,favicon,folder,created_at,sort)
 *   history(id,url,title,visit_at,tab_id)      —— 默认开、上限 5000、可一键清空
 *   downloads(id,url,filename,path,status,size,created_at)
 * Db 内部 Arc<Mutex<Connection>>，可 Clone，跨 Tauri command / axum handler / 钩子共享。
 */
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use tauri::Manager;

const HISTORY_CAP: i64 = 5000;

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
    /// 主库文件路径（内存库为 None）。备份走独立连接，避免 VACUUM INTO 长时间占住共享互斥。
    source: Option<std::path::PathBuf>,
}

/// Tauri 托管状态：main.rs `.manage(DbState(db))`，钩子内 `app.state::<DbState>()` 取用。
pub struct DbState(pub Db);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 数据库文件路径。
/// - env `ANNOTA_DB` 优先；
/// - debug：`<root>/app/service/annota.db`（与 store 同层，方便本地查看）；
/// - release：`app_data_dir/annota.db`。
pub fn resolve_db_path(app: &AppHandle, store: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("ANNOTA_DB") {
        return PathBuf::from(p);
    }
    if cfg!(debug_assertions) {
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let manifest = PathBuf::from(manifest);
            if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
                return root.join("app/service/annota.db");
            }
        }
    }
    if let Some(parent) = store.parent() {
        return parent.join("annota.db");
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Annota"))
        .join("annota.db")
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create db dir: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open db: {e}"))?;
        Self::from_conn(conn, Some(path.to_path_buf()))
    }

    /// P2-D2：文件库/临时库都不可用时的最终兜底——纯内存库（进程级、不落盘）。
    /// 收藏/历史/下载在本进程内仍可用，重启后为空；避免整个应用起不来。
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open memory db: {e}"))?;
        Self::from_conn(conn, None)
    }

    fn from_conn(conn: Connection, source: Option<std::path::PathBuf>) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| format!("pragma: {e}"))?;
        let db = Db { conn: Arc::new(Mutex::new(conn)), source };
        db.migrate()?;
        Ok(db)
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let conn = self.conn.lock().map_err(|_| "数据库锁中毒".to_string())?;
        f(&conn)
    }

    /// P2-D3：带版本号的迁移框架。user_version=1 为当前 schema；
    /// 未来加字段时：version<2 的库跑 v2 迁移并升版本；高版本库拒开（防旧应用写坏新库）。
    fn migrate(&self) -> Result<(), String> {
        let version: i64 = self.with_conn(|c| {
            c.query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(|e| e.to_string())
        })?;
        if version > 1 {
            return Err(format!("数据库版本 {version} 高于本应用支持的 1，请升级 Annota"));
        }
        if version < 1 {
            self.migrate_v1()?;
            self.with_conn(|c| {
                c.execute_batch("PRAGMA user_version = 1")
                    .map_err(|e| e.to_string())
            })?;
        }
        Ok(())
    }

    fn migrate_v1(&self) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS bookmarks (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    url        TEXT NOT NULL UNIQUE,
                    title      TEXT NOT NULL DEFAULT '',
                    favicon    TEXT,
                    folder     TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    sort       INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at DESC);

                 CREATE TABLE IF NOT EXISTS history (
                    id       INTEGER PRIMARY KEY AUTOINCREMENT,
                    url      TEXT NOT NULL,
                    title    TEXT NOT NULL DEFAULT '',
                    visit_at INTEGER NOT NULL,
                    tab_id   TEXT
                 );
                 CREATE INDEX IF NOT EXISTS idx_history_visit ON history(visit_at DESC);

                 CREATE TABLE IF NOT EXISTS downloads (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    url        TEXT NOT NULL,
                    filename   TEXT NOT NULL DEFAULT '',
                    path       TEXT,
                    status     TEXT NOT NULL DEFAULT 'downloading',
                    size       INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);",
            )
            .map_err(|e| format!("migrate: {e}"))
        })
    }

    /// P2-D2：在线一致性备份（VACUUM INTO，WAL 安全）。生成单文件新库。
    pub fn backup_to(&self, dest: &Path) -> Result<(), String> {
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("create backup dir: {e}"))?;
        }
        // OCR-fix：目标已存在先删（同日重备份语义），而非让 SQLite 报错
        if dest.exists() {
            std::fs::remove_file(dest).map_err(|e| format!("remove old backup: {e}"))?;
        }
        let escaped = dest.to_string_lossy().replace('\'', "''");
        let sql = format!("VACUUM INTO '{escaped}'");
        // OCR-fix：优先独立连接执行——VACUUM INTO 是长磁盘操作，走共享互斥会停摆全部 DB 访问
        match &self.source {
            Some(src) => {
                let c = Connection::open(src).map_err(|e| format!("backup open source: {e}"))?;
                c.execute_batch(&sql).map_err(|e| format!("backup: {e}"))
            }
            None => self.with_conn(|c| c.execute_batch(&sql).map_err(|e| format!("backup: {e}"))),
        }
    }

    // ---------- 收藏 ----------
    pub fn list_bookmarks(&self) -> Result<Vec<Value>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT id,url,title,favicon,folder,created_at,sort
                     FROM bookmarks ORDER BY created_at DESC, id DESC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "url": r.get::<_, String>(1)?,
                        "title": r.get::<_, String>(2)?,
                        "favicon": r.get::<_, Option<String>>(3)?,
                        "folder": r.get::<_, String>(4)?,
                        "created_at": r.get::<_, i64>(5)?,
                        "sort": r.get::<_, i64>(6)?,
                    }))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    }

    /// 新增收藏（同 URL 幂等：已存在则返回 false）。
    pub fn add_bookmark(&self, url: &str, title: &str, favicon: Option<&str>) -> Result<bool, String> {
        self.with_conn(|c| {
            // OCR-fix：INSERT OR IGNORE + changes（SELECT-then-INSERT 在第二进程并发下会 UNIQUE 报错而非幂等）
            let n = c
                .execute(
                    "INSERT OR IGNORE INTO bookmarks (url,title,favicon,created_at) VALUES (?1,?2,?3,?4)",
                    params![url, title, favicon, now_ms()],
                )
                .map_err(|e| e.to_string())?;
            Ok(n > 0)
        })
    }

    pub fn remove_bookmark(&self, url: &str) -> Result<bool, String> {
        self.with_conn(|c| {
            let n = c
                .execute("DELETE FROM bookmarks WHERE url=?1", params![url])
                .map_err(|e| e.to_string())?;
            Ok(n > 0)
        })
    }

    // ---------- 历史 ----------
    /// 写入一条历史；随后裁剪到 HISTORY_CAP 条。
    pub fn add_history(&self, url: &str, title: &str, tab_id: Option<&str>) -> Result<(), String> {
        self.with_conn(|c| {
            // OCR-fix：插入与裁剪放同一事务——此前两语句间崩溃会留下超帽状态
            let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO history (url,title,visit_at,tab_id) VALUES (?1,?2,?3,?4)",
                params![url, title, now_ms(), tab_id],
            )
            .map_err(|e| e.to_string())?;
            // OCR-fix：按 visit_at 索引的 OFFSET 子查询裁剪（id NOT IN 每次全表物化，热路径浪费）
            tx.execute(
                "DELETE FROM history WHERE id < (
                     SELECT id FROM history ORDER BY visit_at DESC, id DESC LIMIT 1 OFFSET ?1
                 )",
                params![HISTORY_CAP],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    /// 页面标题加载完成后回填最近一条同 URL 的历史记录（add_history 入库时标题尚未知）。
    pub fn update_history_title(&self, url: &str, title: &str) -> Result<(), String> {
        if title.trim().is_empty() {
            return Ok(());
        }
        self.with_conn(|c| {
            c.execute(
                "UPDATE history SET title = ?1
                 WHERE id = (SELECT id FROM history WHERE url = ?2 ORDER BY visit_at DESC, id DESC LIMIT 1)",
                params![title, url],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    pub fn list_history(&self, limit: i64) -> Result<Vec<Value>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT id,url,title,visit_at,tab_id FROM history
                     ORDER BY visit_at DESC, id DESC LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![limit.max(0)], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "url": r.get::<_, String>(1)?,
                        "title": r.get::<_, String>(2)?,
                        "visit_at": r.get::<_, i64>(3)?,
                        "tab_id": r.get::<_, Option<String>>(4)?,
                    }))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    }

    pub fn clear_history(&self) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute("DELETE FROM history", []).map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    // ---------- 下载 ----------
    /// 记一条下载（status=downloading），返回 rowid。
    pub fn add_download(&self, url: &str, filename: &str, path: Option<&str>) -> Result<i64, String> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO downloads (url,filename,path,status,created_at)
                 VALUES (?1,?2,?3,'downloading',?4)",
                params![url, filename, path, now_ms()],
            )
            .map_err(|e| e.to_string())?;
            Ok(c.last_insert_rowid())
        })
    }

    /// 结束一条下载：按 url 找最近的 downloading 行更新状态/路径/大小。
    pub fn finish_download(
        &self,
        url: &str,
        path: Option<&str>,
        size: i64,
        status: &str,
    ) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE downloads
                    SET status=?1, size=?3, path=COALESCE(?2, path)
                  WHERE id = (
                     SELECT id FROM downloads WHERE url=?4 AND status='downloading'
                     ORDER BY id DESC LIMIT 1)",
                params![status, path, size, url],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    pub fn list_downloads(&self) -> Result<Vec<Value>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT id,url,filename,path,status,size,created_at FROM downloads
                     ORDER BY created_at DESC, id DESC LIMIT 200",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "url": r.get::<_, String>(1)?,
                        "filename": r.get::<_, String>(2)?,
                        "path": r.get::<_, Option<String>>(3)?,
                        "status": r.get::<_, String>(4)?,
                        "size": r.get::<_, i64>(5)?,
                        "created_at": r.get::<_, i64>(6)?,
                    }))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    }

    pub fn clear_downloads(&self) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute("DELETE FROM downloads", []).map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    // ---------- omnibox 智能搜索 ----------
    /// 搜索历史与收藏，返回 {history: [...], bookmarks: [...]}，各限 5 条。
    pub fn search_omnibox(&self, q: &str) -> Result<Value, String> {
        let q = q.trim();
        if q.is_empty() {
            return Ok(json!({ "history": [], "bookmarks": [] }));
        }
        // OCR-fix：转义 LIKE 元字符并声明 ESCAPE，防止输入 % 或 _ 变成通配（如搜 "_" 命中全部）
        let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT url,title,visit_at FROM history
                     WHERE url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\'
                     ORDER BY visit_at DESC LIMIT 5",
                )
                .map_err(|e| e.to_string())?;
            let history = stmt
                .query_map(params![pattern], |r| {
                    Ok(json!({
                        "url": r.get::<_, String>(0)?,
                        "title": r.get::<_, String>(1)?,
                        "visit_at": r.get::<_, i64>(2)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            let mut stmt = c
                .prepare(
                    "SELECT url,title,favicon FROM bookmarks
                     WHERE url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\'
                     ORDER BY created_at DESC LIMIT 5",
                )
                .map_err(|e| e.to_string())?;
            let bookmarks = stmt
                .query_map(params![pattern], |r| {
                    Ok(json!({
                        "url": r.get::<_, String>(0)?,
                        "title": r.get::<_, String>(1)?,
                        "favicon": r.get::<_, Option<String>>(2)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            Ok(json!({ "history": history, "bookmarks": bookmarks }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db() -> Db {
        let p = std::env::temp_dir().join(format!("annota-test-{}.db", uuid::Uuid::new_v4()));
        Db::open(&p).expect("open temp db")
    }

    #[test]
    fn bookmarks_crud_and_idempotent() {
        let db = tmp_db();
        assert!(db.add_bookmark("https://a.com/x", "A", None).unwrap());
        // 同 URL 幂等
        assert!(!db.add_bookmark("https://a.com/x", "A2", Some("i")).unwrap());
        let list = db.list_bookmarks().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["url"], "https://a.com/x");
        assert_eq!(list[0]["title"], "A");
        assert!(db.remove_bookmark("https://a.com/x").unwrap());
        assert_eq!(db.list_bookmarks().unwrap().len(), 0);
        // 删除不存在返回 false
        assert!(!db.remove_bookmark("https://nope").unwrap());
    }

    #[test]
    fn history_order_and_clear() {
        let db = tmp_db();
        db.add_history("https://a.com", "", Some("browser")).unwrap();
        db.add_history("https://b.com", "", Some("tab-2")).unwrap();
        let list = db.list_history(10).unwrap();
        assert_eq!(list.len(), 2);
        // 最近的在最前
        assert_eq!(list[0]["url"], "https://b.com");
        assert_eq!(list[0]["tab_id"], "tab-2");
        db.clear_history().unwrap();
        assert_eq!(db.list_history(10).unwrap().len(), 0);
    }

    #[test]
    fn omnibox_searches_history_and_bookmarks() {
        let db = tmp_db();
        db.add_bookmark("https://www.bilibili.com/video/BV1xx", "BBC 纪录片", None)
            .unwrap();
        db.add_history("https://www.bilibili.com/video/BV1yy", "BBC 纪录片 第二集", None)
            .unwrap();
        db.add_history("https://youtube.com/watch?v=z", "别的站", None)
            .unwrap();

        let r = db.search_omnibox("bilibili").unwrap();
        assert_eq!(r["bookmarks"].as_array().unwrap().len(), 1);
        assert_eq!(r["history"].as_array().unwrap().len(), 1);

        // 标题匹配也要能命中
        let r = db.search_omnibox("BBC").unwrap();
        assert_eq!(r["bookmarks"].as_array().unwrap().len(), 1);
        assert_eq!(r["history"].as_array().unwrap().len(), 1);

        // 无匹配返回空数组
        let r = db.search_omnibox("不存在的站").unwrap();
        assert!(r["bookmarks"].as_array().unwrap().is_empty());
        assert!(r["history"].as_array().unwrap().is_empty());

        // 空查询不查库
        let r = db.search_omnibox("   ").unwrap();
        assert!(r["bookmarks"].as_array().unwrap().is_empty());
    }

    #[test]
    fn downloads_lifecycle() {
        let db = tmp_db();
        db.add_download("https://a.com/f.bin", "f.bin", Some("/tmp/f.bin"))
            .unwrap();
        let list = db.list_downloads().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["status"], "downloading");
        db.finish_download("https://a.com/f.bin", Some("/tmp/f.bin"), 1234, "done")
            .unwrap();
        let list = db.list_downloads().unwrap();
        assert_eq!(list[0]["status"], "done");
        assert_eq!(list[0]["size"], 1234);
        db.clear_downloads().unwrap();
        assert_eq!(db.list_downloads().unwrap().len(), 0);
    }

    #[test]
    fn memory_db_fallback_and_history_title() {
        // P1-b#11：内存库兜底（文件库/临时库都失败时的最终降级路径）
        let db = Db::open_in_memory().expect("memory db");
        db.add_history("https://v.example.com/watch/1", "", Some("tab-1")).unwrap();
        assert_eq!(db.list_history(10).unwrap().len(), 1);
        // P1-a#4：标题回填到最近一条同 URL 记录
        db.update_history_title("https://v.example.com/watch/1", "示例视频").unwrap();
        let list = db.list_history(10).unwrap();
        assert_eq!(list[0]["title"], "示例视频");
        // 空标题不覆盖已有标题
        db.update_history_title("https://v.example.com/watch/1", "").unwrap();
        assert_eq!(db.list_history(10).unwrap()[0]["title"], "示例视频");
        // 不存在的 URL 不报错
        db.update_history_title("https://nowhere/", "x").unwrap();
    }

    #[test]
    fn omnibox_like_metacharacters_are_escaped() {
        let db = tmp_db();
        db.add_history("https://a.com/x", "hello_world", None).unwrap();
        db.add_history("https://b.com/y", "nothing", None).unwrap();
        // OCR-fix 回归：转义后 "_" 不再是通配符
        let r = db.search_omnibox("hello_world").unwrap();
        assert_eq!(r["history"].as_array().unwrap().len(), 1, "含 _ 的查询应精确命中");
        let r2 = db.search_omnibox("_").unwrap();
        assert_eq!(r2["history"].as_array().unwrap().len(), 1, "裸 _ 应按字面命中含下划线的 1 条（通配行为会命中全部 2 条）");
        let r3 = db.search_omnibox("%").unwrap();
        assert_eq!(r3["history"].as_array().unwrap().len(), 0, "裸 % 不应命中全部");
    }
}
