#!/usr/bin/env python3
"""同步语义单测：推送（replace）以本地为准；覆盖时不丢 updated；无词按备注区分。

用法: python3 dev/sync_replace.test.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "app", "service"))
import sync_server as S  # noqa: E402


def box():
    return {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}


def main():
    # 1) merge_entries 全量替换语义（replace）：只保留本次推送的 entries
    server = [
        {"id": "a", "word": "apple", "label": "苹果", "box": box(), "t": 1.0, "updated": "2026-01-01T00:00:00Z"},
        {"id": "b", "word": "banana", "label": "香蕉", "box": box(), "t": 2.0, "updated": "2026-01-01T00:00:00Z"},
    ]
    pushed = [
        {"id": "a", "word": "apple", "label": "苹果（改）", "box": box(), "t": 1.0, "updated": "2026-02-02T00:00:00Z"},
    ]
    merged = S.merge_entries([], pushed)   # replace：忽略 cur，仅本次推送
    assert [e["id"] for e in merged] == ["a"], merged
    assert merged[0]["label"] == "苹果（改）", merged
    assert merged[0]["updated"] == "2026-02-02T00:00:00Z", "updated 必须保留"

    # 2) 本地为主：推送空列表 = 清空（用户删完所有条目并同步）
    assert S.merge_entries([], []) == []

    # 3) 无词条目按备注区分（不被误并）
    a = {"id": "x", "label": "意见A", "box": box(), "t": 1.0}
    b = {"id": "y", "label": "意见B", "box": box(), "t": 1.0}
    assert len(S.merge_entries([a], [b])) == 2

    # 3b) 无词、同备注但标签不同 → 不同标注（tags 纳入去重）
    c = {"id": "c", "tags": ["日语"], "box": box(), "t": 1.0}
    d = {"id": "d", "tags": ["法语"], "box": box(), "t": 1.0}
    assert len(S.merge_entries([c], [d])) == 2, "纯标签标注不应被误并"
    c2 = {"id": "c2", "tags": ["日语"], "box": box(), "t": 1.0}
    assert len(S.merge_entries([c], [c2])) == 1, "同标签应去重"

    # 4) updated 透传：入 → 出字段不丢
    e = {"id": "z", "tags": ["日语"], "label": "注釈", "box": box(), "t": 3.0, "updated": "2026-03-03T00:00:00Z"}
    out = S.merge_entries([], [e])
    assert out[0]["updated"] == "2026-03-03T00:00:00Z" and out[0]["tags"] == ["日语"]

    print("sync_replace.test.py  PASS")


if __name__ == "__main__":
    main()
