#!/usr/bin/env python3
"""从姐妹仓库 ielts-7.5 的雅思/托福词表压出轻量索引 → dist/vocab.json

紧凑格式（数组套数组，省体积）：
  [word, phonetic, cn, pos, tag]
  tag: i=雅思 t=托福 it=两者皆有
"""
import argparse, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CACHE = os.path.join(HERE, "..", "ielts-7.5", "assets", "vocab", ".cache")
OUT = os.path.join(HERE, "dist", "vocab.json")

POS_MAP = {"adj": "a", "adv": "ad", "prep": "prep", "conj": "conj", "pron": "pron",
           "num": "num", "art": "art", "aux": "aux", "int": "int"}


def load(path, tag, table):
    if not os.path.exists(path):
        print("  ! 缺文件:", path)
        return
    n = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            w = (o.get("word") or "").strip()
            if not w:
                continue
            key = w.lower()
            ph = (o.get("us") or o.get("uk") or "").strip()
            tr = o.get("translations") or []
            cn = "；".join((t.get("translation") or "").strip() for t in tr if t.get("translation"))
            cn = cn[:44]
            pos = ""
            if tr and tr[0].get("type"):
                pos = tr[0]["type"].strip()
            pos = POS_MAP.get(pos, pos)
            if key in table:
                row = table[key]
                row[4] = "it" if row[4] != tag else row[4]
                if not row[2]:
                    row[2] = cn
            else:
                table[key] = [w, ph, cn, pos, tag]
                n += 1
    print("  %-10s +%d" % (os.path.basename(path), n))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    a = ap.parse_args()
    table = {}
    print("读取词表：")
    load(os.path.join(a.cache, "雅思.jsonl"), "i", table)
    load(os.path.join(a.cache, "托福.jsonl"), "t", table)

    rows = sorted(table.values(), key=lambda r: r[0].lower())
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
    print("输出:", os.path.relpath(OUT, HERE), len(rows), "词", os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
