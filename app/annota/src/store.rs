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
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| format!("pragma: {e}"))?;
        let db = Db { conn: Arc::new(Mutex::new(conn)) };
        db.migrate()?;
        Ok(db)
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let conn = self.conn.lock().map_err(|_| "数据库锁中毒".to_string())?;
        f(&conn)
    }

    fn migrate(&self) -> Result<(), String> {
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
            let exists: i64 = c
                .query_row("SELECT COUNT(*) FROM bookmarks WHERE url=?1", params![url], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if exists > 0 {
                return Ok(false);
            }
            c.execute(
                "INSERT INTO bookmarks (url,title,favicon,created_at) VALUES (?1,?2,?3,?4)",
                params![url, title, favicon, now_ms()],
            )
            .map_err(|e| e.to_string())?;
            Ok(true)
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
            c.execute(
                "INSERT INTO history (url,title,visit_at,tab_id) VALUES (?1,?2,?3,?4)",
                params![url, title, now_ms(), tab_id],
            )
            .map_err(|e| e.to_string())?;
            c.execute(
                "DELETE FROM history WHERE id NOT IN (
                     SELECT id FROM history ORDER BY visit_at DESC, id DESC LIMIT ?1)",
                params![HISTORY_CAP],
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
        let pattern = format!("%{}%", q);
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT url,title,visit_at FROM history
                     WHERE url LIKE ?1 OR title LIKE ?1
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
                     WHERE url LIKE ?1 OR title LIKE ?1
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
}
