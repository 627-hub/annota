#!/usr/bin/env python3
"""Annota · 最小 .apkg 写出器（标准库，无依赖）

把一个媒体的标注逐条导出为「截图卡 → Anki 牌组」。格式与 Anki 2.1 / genanki
产出兼容（表结构、media 索引一致），仅用于**用户本地的个人导出**。
共享 Pack 仍是纯标注 JSON，绝不包含截图（见 docs/architecture.md ADR-6）。

只依赖标准库：json / sqlite3 / zipfile / hashlib / tempfile。
"""
import hashlib
import itertools
import json
import os
import sqlite3
import tempfile
import time
import zipfile

MODEL_ID = 1730000001            # 固定：重复导入 = 更新，不新建模型
DEFAULT_DECK_ID = 1730000101     # 兜底 deck id（调用方可传稳定的 deck_id）

_BASE91 = list("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
               "0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~")

# ---- Anki .apkg 集合 schema（Anki 2.1 旧格式，导入时自动迁移）----
_SCHEMA = """
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
"""


def guid_for(*values):
    """与 Anki 一致的 base91(sha256 前 8 字节)；同输入 → 同 guid（幂等更新）。"""
    h = hashlib.sha256("__".join(str(v) for v in values).encode("utf-8")).digest()[:8]
    n = int.from_bytes(h, "big")
    out = []
    while n > 0:
        n, r = divmod(n, len(_BASE91))
        out.append(_BASE91[r])
    return "".join(reversed(out)) or _BASE91[0]


def deck_id_for(name):
    """由牌组名派生稳定整数 id（重复导入更新同一牌组）。"""
    h = hashlib.sha256(("annota:" + (name or "Annota")).encode("utf-8")).digest()[:4]
    return 1730000000 + (int.from_bytes(h, "big") % 10000000)


def _model(timestamp):
    fields = ["Front", "Back"]
    return {
        "id": str(MODEL_ID), "name": "Annota 截图卡", "type": 0, "usn": -1,
        "mod": int(timestamp), "did": DEFAULT_DECK_ID, "sortf": 0, "tags": [], "vers": [],
        "latexPre": "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n"
                    "\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n"
                    "\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
        "latexPost": "\\end{document}", "latexsvg": False,
        "flds": [{"name": n, "ord": i, "font": "Liberation Sans", "media": [],
                  "rtl": False, "size": 20, "sticky": False} for i, n in enumerate(fields)],
        "tmpls": [{"name": "Card 1", "ord": 0, "qfmt": "{{Front}}",
                   "afmt": "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
                   "bafmt": "", "bqfmt": "", "bfont": "", "bsize": 0, "did": None}],
        "req": [[0, "any", [0]]],
        "css": ".card{font-family:-apple-system,'PingFang SC',sans-serif;font-size:19px;"
               "text-align:center;color:#17181c;background:#fff;line-height:1.5}"
               ".card img{max-width:100%;max-height:70vh;border-radius:6px}"
               ".va-back{margin-top:6px}.va-word{font-size:26px;font-weight:700}"
               ".va-meta{color:#666;font-size:15px;margin-top:4px}"
               ".va-src{color:#999;font-size:13px;margin-top:8px}",
    }


def _default_deck():
    return {"collapsed": False, "conf": 1, "desc": "", "dyn": 0, "extendNew": 10,
            "extendRev": 50, "id": 1, "lrnToday": [0, 0], "mod": 0, "name": "Default",
            "newToday": [0, 0], "revToday": [0, 0], "timeToday": [0, 0], "usn": 0}


def _default_col(now):
    col = {
        "id": 1, "crt": int(now), "mod": int(now * 1000), "scm": int(now * 1000), "ver": 11,
        "dty": 0, "usn": 0, "ls": 0,
        "conf": json.dumps({"activeDecks": [1], "addToCur": True, "collapseTime": 1200,
                            "curDeck": 1, "curModel": str(MODEL_ID), "dueCounts": True,
                            "estTimes": True, "newBury": True, "newSpread": 0, "nextPos": 1,
                            "sortBackwards": False, "sortType": "noteFld", "timeLim": 0}),
        "models": "{}",
        "decks": json.dumps({"1": _default_deck()}),
        "dconf": json.dumps({"1": {
            "autoplay": True, "id": 1, "lapse": {"delays": [10], "leechAction": 0,
            "leechFails": 8, "minInt": 1, "mult": 0}, "maxTaken": 60, "mod": 0, "name": "Default",
            "new": {"bury": True, "delays": [1, 10], "initialFactor": 2500, "ints": [1, 4, 7],
                    "order": 1, "perDay": 20, "separate": True}, "replayq": True,
            "rev": {"bury": True, "ease4": 1.3, "fuzz": 0.05, "ivlFct": 1, "maxIvl": 36500,
                    "minSpace": 1, "perDay": 100}, "timer": 0, "usn": 0}}),
        "tags": "{}",
    }
    return col


def build_apkg(out_path, deck_name, notes, media=None, deck_id=None, timestamp=None):
    """写一个 .apkg。

    deck_name : 牌组名（重复导入更新同一牌组）
    notes     : [{"guid","front","back","tags":[...],"sort"}]，front/back 为 HTML
    media     : [(basename, bytes)]，front/back 里以 <img src="basename"> 引用
    deck_id   : 稳定整数；缺省由 deck_name 派生
    """
    media = list(media or [])
    deck_id = int(deck_id or deck_id_for(deck_name))
    ts = float(timestamp if timestamp is not None else time.time())
    # note/card id 基数：millis 单调 + 随机后缀，跨次导出不撞
    id_base = int(ts * 1000) * 1000 + int.from_bytes(os.urandom(2), "big")

    db_fd, db_path = tempfile.mkstemp(suffix=".anki2")
    os.close(db_fd)
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.executescript(_SCHEMA)
        c = _default_col(ts)
        cur.execute("INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (c["id"], c["crt"], c["mod"], c["scm"], c["ver"], c["dty"], c["usn"],
                     c["ls"], c["conf"], c["models"], c["decks"], c["dconf"], c["tags"]))

        # 注册 deck 与 model
        decks = json.loads(c["decks"])
        decks[str(deck_id)] = {**_default_deck(), "id": deck_id, "name": deck_name, "usn": -1}
        cur.execute("UPDATE col SET decks=?", (json.dumps(decks),))
        model = _model(ts)
        model["did"] = deck_id   # 模型默认牌组指向本次实际牌组，避免悬空引用
        models = {str(MODEL_ID): model}
        cur.execute("UPDATE col SET models=?", (json.dumps(models),))

        idgen = itertools.count(id_base)
        for nt in notes:
            flds = (nt.get("front", "") or "") + "\x1f" + (nt.get("back", "") or "")
            tags = " " + " ".join(nt.get("tags") or []) + " "
            cur.execute("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (next(idgen), nt["guid"], MODEL_ID, int(ts), -1, tags, flds,
                         nt.get("sort", "") or "", 0, 0, ""))
            nid = cur.lastrowid
            cur.execute("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (next(idgen), nid, deck_id, 0, int(ts), -1, 0, 0, nt.get("due", 0),
                         0, 0, 0, 0, 0, 0, 0, 0, ""))
        conn.commit()

        os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(db_path, "collection.anki2")
            z.writestr("media", json.dumps({i: os.path.basename(p)
                                            for i, (p, _b) in enumerate(media)}))
            for i, (_name, blob) in enumerate(media):
                z.writestr(str(i), blob)
        return out_path
    finally:
        if conn is not None:
            try: conn.close()
            except Exception: pass
        if os.path.exists(db_path):
            os.remove(db_path)
