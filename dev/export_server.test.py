#!/usr/bin/env python3
"""本地服务「批量导出」端点单测：card 累积 → finalize 出 .apkg。

用法: python3 dev/export_server.test.py
"""
import base64
import json
import os
import sqlite3
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "app", "service"))
import sync_server as S  # noqa: E402

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
SHOT = "data:image/png;base64," + base64.b64encode(PNG).decode()

MEDIA = {"mediaId": "BV1xx411c7mD", "platform": "bilibili",
         "title": "Test Video", "url": "https://www.bilibili.com/video/BV1xx411c7mD"}


def main():
    S.EXPORTS = tempfile.mkdtemp(prefix="annota-exports-")

    r0 = S.export_card({"deck_id": "d1", "idx": 0,
                        "entry": {"id": "e1", "word": "tractor", "label": "拖拉机",
                                  "pos": "n", "t": 12.4, "tags": ["ielts"]},
                        "media": MEDIA, "screenshot": SHOT})
    assert r0["has_shot"] is True and r0["done"] == 1, r0
    r1 = S.export_card({"deck_id": "d1", "idx": 1,
                        "entry": {"id": "e2", "word": "harvest", "label": "收割", "t": 3.2},
                        "media": MEDIA, "screenshot": None})
    assert r1["has_shot"] is False and r1["done"] == 2, r1

    # 幂等覆写：同 idx 再来一次不增加条数（非首卡，不清批）
    assert S.export_card({"deck_id": "d1", "idx": 1,
                          "entry": {"id": "e2", "word": "harvest", "label": "收割", "t": 3.2},
                          "media": MEDIA, "screenshot": None})["done"] == 2

    # 新一批导出：idx 0 先清空上一批（避免按 idx 命名的残留旧卡）
    r_batch2 = S.export_card({"deck_id": "d1", "idx": 0,
                              "entry": {"id": "e9", "word": "fresh", "t": 1.0},
                              "media": MEDIA, "screenshot": SHOT})
    assert r_batch2["done"] == 1, r_batch2

    # 补第二卡，完成本批
    S.export_card({"deck_id": "d1", "idx": 1, "entry": {"id": "e10", "word": "second", "t": 2.0},
                   "media": MEDIA, "screenshot": None})
    res = S.export_finalize({"deck_id": "d1", "deck_name": "Annota 测试"})
    assert res["cards"] == 2 and res["media"] == 1, res
    assert res["url"].startswith("/exports/") and os.path.isfile(res["path"])

    with zipfile.ZipFile(res["path"]) as z:
        assert "collection.anki2" in z.namelist()
        media = json.loads(z.read("media"))
        assert len(media) == 1, media
        db = z.read("collection.anki2")
    fd, tmp = tempfile.mkstemp(suffix=".anki2")
    os.write(fd, db); os.close(fd)
    conn = sqlite3.connect(tmp)
    assert conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 2
    flds = [r[0] for r in conn.execute("SELECT flds FROM notes ORDER BY id")]
    assert any("annota_0.png" in f for f in flds), flds
    assert any("fresh" in f for f in flds), flds
    conn.close()

    # finalize 幂等：再跑一次得到同样内容
    res2 = S.export_finalize({"deck_id": "d1", "deck_name": "Annota 测试"})
    assert res2["path"] == res["path"] and res2["cards"] == 2
    print("export_server.test.py  PASS")


if __name__ == "__main__":
    main()
