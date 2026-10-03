#!/usr/bin/env python3
"""anki_export 单测：结构校验 + 与 genanki 产出对齐（genanki 装了才比）。

用法: python3 dev/anki_export.test.py
"""
import base64
import json
import os
import sqlite3
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "app", "service"))
import anki_export  # noqa: E402

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

TABLES = {"col", "notes", "cards", "revlog", "graves"}


def open_collection(path):
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        media = json.loads(z.read("media"))
        db = z.read("collection.anki2")
    fd, tmp = tempfile.mkstemp(suffix=".anki2")
    os.write(fd, db)
    os.close(fd)
    conn = sqlite3.connect(tmp)
    return names, media, conn


def test_guid_idempotent():
    assert anki_export.guid_for("m1", "e1") == anki_export.guid_for("m1", "e1")
    assert anki_export.guid_for("m1", "e1") != anki_export.guid_for("m1", "e2")


def test_deck_id_stable():
    assert anki_export.deck_id_for("雅思 · BV1") == anki_export.deck_id_for("雅思 · BV1")
    assert isinstance(anki_export.deck_id_for("x"), int)


def test_build_apkg():
    notes = [
        {"guid": anki_export.guid_for("m1", "e1"),
         "front": '<img src="c0.png">', "back": "<b>tractor</b> 拖拉机 [n]",
         "tags": ["annota", "bilibili"], "sort": "tractor"},
        {"guid": anki_export.guid_for("m1", "e2"),
         "front": "no-shot card", "back": "harvest 收割 [v]", "tags": ["annota"], "sort": "harvest"},
    ]
    out = os.path.join(tempfile.mkdtemp(), "deck.apkg")
    anki_export.build_apkg(out, "Annota · 测试", notes, media=[("c0.png", PNG)], timestamp=1700000000)

    assert zipfile.is_zipfile(out)
    names, media, conn = open_collection(out)
    assert "collection.anki2" in names, names
    assert "media" in names
    assert media == {"0": "c0.png"}, media
    assert "0" in names, names

    tset = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert TABLES.issubset(tset), tset

    n_notes = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
    n_cards = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    assert n_notes == 2, n_notes
    assert n_cards == 2, n_cards

    conf, models, decks = conn.execute("SELECT conf, models, decks FROM col").fetchone()
    assert json.loads(conf)["curDeck"] == 1
    m = json.loads(models)
    assert str(anki_export.MODEL_ID) in m
    assert [f["name"] for f in m[str(anki_export.MODEL_ID)]["flds"]] == ["Front", "Back"]
    d = json.loads(decks)
    assert any(v.get("name") == "Annota · 测试" for v in d.values()), d

    flds = [r[0] for r in conn.execute("SELECT flds FROM notes ORDER BY id")]
    assert "\x1f" in flds[0]
    assert "c0.png" in flds[0]
    conn.close()


def test_against_genanki():
    try:
        import genanki  # noqa: F401
    except ImportError:
        print("  (skip genanki 对拍：未安装)")
        return
    import genanki
    m = genanki.Model(anki_export.MODEL_ID, "Annota 截图卡",
                      fields=[{"name": "Front"}, {"name": "Back"}],
                      templates=[{"name": "Card 1", "qfmt": "{{Front}}",
                                  "afmt": "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}"}])
    deck = genanki.Deck(anki_export.deck_id_for("Annota · 对拍"), "Annota · 对拍")
    deck.add_note(genanki.Note(model=m, fields=["front", "back"], guid="g1"))
    out = os.path.join(tempfile.mkdtemp(), "ref.apkg")
    genanki.Package(deck).write_to_file(out)
    names, media, conn = open_collection(out)
    tset = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert TABLES.issubset(tset), tset
    assert set(media) == set(), media
    conn.close()
    print("  genanki 对拍 OK（表结构一致）")


if __name__ == "__main__":
    test_guid_idempotent()
    test_deck_id_stable()
    test_build_apkg()
    test_against_genanki()
    print("anki_export.test.py  PASS")
