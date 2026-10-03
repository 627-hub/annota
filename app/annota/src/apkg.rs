//! Annota · 最小 .apkg 写出器（Rust，对称于 app/service/anki_export.py）。
//! rusqlite(bundled) + zip；产出与 genanki / Anki 2.1 兼容。
//! 仅用于**用户本地的个人导出**；共享 Pack 不含截图（docs/architecture.md ADR-6）。

use rusqlite::{params, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;

pub const MODEL_ID: i64 = 1_730_000_001;

const BASE91: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

const SCHEMA: &str = r#"
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null, usn integer not null,
  ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null,
  mod integer not null, usn integer not null, tags text not null, flds text not null,
  sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null,
  ord integer not null, mod integer not null, usn integer not null, type integer not null,
  queue integer not null, due integer not null, ivl integer not null, factor integer not null,
  reps integer not null, lapses integer not null, left integer not null, odue integer not null,
  odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null,
  ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null,
  time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
"#;

pub struct Note {
    pub guid: String,
    pub front: String,
    pub back: String,
    pub tags: Vec<String>,
    pub sort: String,
}

pub struct Media {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// 与 Anki 一致的 base91(sha256 前 8 字节)：同输入 → 同 guid（幂等更新）。
pub fn guid_for(values: &[&str]) -> String {
    let digest = Sha256::digest(values.join("__").as_bytes());
    let mut n: u64 = 0;
    for b in &digest[..8] {
        n = (n << 8) | (*b as u64);
    }
    if n == 0 {
        return (BASE91[0] as char).to_string();
    }
    let mut out: Vec<char> = Vec::new();
    while n > 0 {
        out.push(BASE91[(n % BASE91.len() as u64) as usize] as char);
        n /= BASE91.len() as u64;
    }
    out.into_iter().rev().collect()
}

/// 由牌组名派生稳定整数 id（重复导入更新同一牌组）。
pub fn deck_id_for(name: &str) -> i64 {
    let digest = Sha256::digest(format!("annota:{}", name).as_bytes());
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    1_730_000_000i64 + (n % 10_000_000) as i64
}

fn model_json(ts: i64) -> serde_json::Value {
    let field = |name: &str, ord: i64| json!({
        "name": name, "ord": ord, "font": "Liberation Sans", "media": [],
        "rtl": false, "size": 20, "sticky": false
    });
    json!({
        "id": MODEL_ID.to_string(), "name": "Annota 截图卡", "type": 0, "usn": -1,
        "mod": ts, "did": 1, "sortf": 0, "tags": [], "vers": [],
        "latexPre": "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
        "latexPost": "\\end{document}", "latexsvg": false,
        "flds": [field("Front", 0), field("Back", 1)],
        "tmpls": [{
            "name": "Card 1", "ord": 0, "qfmt": "{{Front}}",
            "afmt": "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
            "bafmt": "", "bqfmt": "", "bfont": "", "bsize": 0, "did": null
        }],
        "req": [[0, "any", [0]]],
        "css": ".card{font-family:-apple-system,'PingFang SC',sans-serif;font-size:19px;text-align:center;color:#17181c;background:#fff;line-height:1.5}.card img{max-width:100%;max-height:70vh;border-radius:6px}.va-word{font-size:26px;font-weight:700}.va-meta{color:#666;font-size:15px;margin-top:4px}.va-src{color:#999;font-size:13px;margin-top:8px}"
    })
}

fn default_deck(deck_id: i64, deck_name: &str) -> serde_json::Value {
    json!({
        "collapsed": false, "conf": 1, "desc": "", "dyn": 0, "extendNew": 0,
        "extendRev": 50, "id": deck_id, "lrnToday": [0, 0], "mod": 0, "name": deck_name,
        "newToday": [0, 0], "revToday": [0, 0], "timeToday": [0, 0], "usn": -1
    })
}

/// 写一个 .apkg（deck_name 重复导入会更新同一牌组）。
pub fn build_apkg(
    out_path: &Path,
    deck_name: &str,
    notes: &[Note],
    media: &[Media],
    timestamp: Option<i64>,
) -> Result<(), String> {
    let ts = timestamp.unwrap_or_else(|| chrono::Local::now().timestamp());
    let deck_id = deck_id_for(deck_name);
    let uuid = uuid::Uuid::new_v4();
    // note/card id 基数：millis 单调 + 随机，跨次导出不撞
    let mut next_id = ts * 1_000_000 + ((uuid.as_u128() as i64).rem_euclid(1000));
    let db_path = std::env::temp_dir().join(format!("annota-{}.anki2", uuid));

    let result = (|| -> Result<(), String> {
        {
            let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
            conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;

            let conf = json!({
                "activeDecks": [1], "addToCur": true, "collapseTime": 1200, "curDeck": 1,
                "curModel": MODEL_ID.to_string(), "dueCounts": true, "estTimes": true,
                "newBury": true, "newSpread": 0, "nextPos": 1, "sortBackwards": false,
                "sortType": "noteFld", "timeLim": 0
            })
            .to_string();
            let dconf = json!({"1": {
                "autoplay": true, "id": 1,
                "lapse": {"delays": [10], "leechAction": 0, "leechFails": 8, "minInt": 1, "mult": 0},
                "maxTaken": 60, "mod": 0, "name": "Default",
                "new": {"bury": true, "delays": [1, 10], "initialFactor": 2500, "ints": [1, 4, 7], "order": 1, "perDay": 20, "separate": true},
                "replayq": true,
                "rev": {"bury": true, "ease4": 1.3, "fuzz": 0.05, "ivlFct": 1, "maxIvl": 36500, "minSpace": 1, "perDay": 100},
                "timer": 0, "usn": 0
            }})
            .to_string();
            let decks = json!({"1": {
                "collapsed": false, "conf": 1, "desc": "", "dyn": 0, "extendNew": 10,
                "extendRev": 50, "id": 1, "lrnToday": [0, 0], "mod": 0, "name": "Default",
                "newToday": [0, 0], "revToday": [0, 0], "timeToday": [0, 0], "usn": 0
            }})
            .to_string();

            conn.execute(
                "INSERT INTO col VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![1i64, ts, ts * 1000, ts * 1000, 11i64, 0i64, 0i64, 0i64, conf, "{}", decks, dconf, "{}"],
            )
            .map_err(|e| e.to_string())?;

            let mut decks_map = serde_json::Map::new();
            decks_map.insert(
                "1".to_string(),
                json!({"collapsed": false, "conf": 1, "desc": "", "dyn": 0, "extendNew": 10,
                       "extendRev": 50, "id": 1, "lrnToday": [0, 0], "mod": 0, "name": "Default",
                       "newToday": [0, 0], "revToday": [0, 0], "timeToday": [0, 0], "usn": 0}),
            );
            decks_map.insert(deck_id.to_string(), default_deck(deck_id, deck_name));
            let all_decks = serde_json::Value::Object(decks_map).to_string();
            conn.execute("UPDATE col SET decks=?1", params![all_decks]).map_err(|e| e.to_string())?;
            let mut models_map = serde_json::Map::new();
            let mut model = model_json(ts);
            model["did"] = json!(deck_id);   // 模型默认牌组指向本次实际牌组
            models_map.insert(MODEL_ID.to_string(), model);
            let models = serde_json::Value::Object(models_map).to_string();
            conn.execute("UPDATE col SET models=?1", params![models]).map_err(|e| e.to_string())?;

            for note in notes {
                let flds = format!("{}\u{1f}{}", note.front, note.back);
                let tags = format!(" {} ", note.tags.join(" "));
                conn.execute(
                    "INSERT INTO notes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                    params![next_id, note.guid, MODEL_ID, ts, -1i64, tags, flds, note.sort, 0i64, 0i64, ""],
                )
                .map_err(|e| e.to_string())?;
                let nid = conn.last_insert_rowid();
                next_id += 1;
                conn.execute(
                    "INSERT INTO cards VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
                    params![next_id, nid, deck_id, 0i64, ts, -1i64, 0i64, 0i64, 0i64, 0i64, 0i64, 0i64, 0i64, 0i64, 0i64, 0i64, 0i64, ""],
                )
                .map_err(|e| e.to_string())?;
                next_id += 1;
            }
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let file = std::fs::File::create(out_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let db_bytes = std::fs::read(&db_path).map_err(|e| e.to_string())?;
        zip.start_file("collection.anki2", opts).map_err(|e| e.to_string())?;
        zip.write_all(&db_bytes).map_err(|e| e.to_string())?;

        let mut map = serde_json::Map::new();
        for (i, m) in media.iter().enumerate() {
            map.insert(i.to_string(), json!(m.name));
        }
        zip.start_file("media", opts).map_err(|e| e.to_string())?;
        zip.write_all(serde_json::to_string(&map).map_err(|e| e.to_string())?.as_bytes())
            .map_err(|e| e.to_string())?;
        for (i, m) in media.iter().enumerate() {
            zip.start_file(i.to_string(), opts).map_err(|e| e.to_string())?;
            zip.write_all(&m.bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })();

    let _ = std::fs::remove_file(&db_path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_is_deterministic() {
        assert_eq!(guid_for(&["m1", "e1"]), guid_for(&["m1", "e1"]));
        assert_ne!(guid_for(&["m1", "e1"]), guid_for(&["m1", "e2"]));
    }

    #[test]
    fn writes_readable_apkg() {
        let dir = std::env::temp_dir().join(format!("annota-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("deck.apkg");
        let notes = vec![
            Note { guid: guid_for(&["BV1", "e1"]), front: "<img src=\"c0.png\">".into(), back: "<b>tractor</b> 拖拉机".into(), tags: vec!["annota".into()], sort: "tractor".into() },
            Note { guid: guid_for(&["BV1", "e2"]), front: "no shot".into(), back: "harvest 收割".into(), tags: vec![], sort: "harvest".into() },
        ];
        let media = vec![Media { name: "c0.png".into(), bytes: vec![0x89, 0x50, 0x4e, 0x47] }];
        build_apkg(&out, "Annota 测试", &notes, &media, Some(1_700_000_000)).unwrap();

        // zip 结构
        let f = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(f).unwrap();
        assert!(zip.by_name("collection.anki2").is_ok());
        assert!(zip.by_name("media").is_ok());
        assert!(zip.by_name("0").is_ok());

        // sqlite 结构
        let conn = Connection::open(&out).ok();
        let _ = conn; // 直接开 .apkg 不是 sqlite；解出 collection 再校验
        let mut bytes = Vec::new();
        {
            let mut z = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
            use std::io::Read;
            z.by_name("collection.anki2").unwrap().read_to_end(&mut bytes).unwrap();
        }
        let db = dir.join("c.anki2");
        std::fs::write(&db, &bytes).unwrap();
        let conn = Connection::open(&db).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        let c: i64 = conn.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0)).unwrap();
        assert_eq!((n, c), (2, 2));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
