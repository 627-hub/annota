#!/usr/bin/env python3
"""R2 Step 1 · 合并规则单测：box 与 quote 二选一，quote 按 exact 去重。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app", "service"))
import sync_server as S  # noqa: E402


class MergeRules(unittest.TestCase):
    def test_accepts_quote_without_box(self):
        e = {"id": "q1", "word": "agriculture", "quote": {"exact": "the tea was planted"}}
        self.assertEqual(len(S.merge_entries([], [e])), 1)

    def test_accepts_box_without_quote(self):
        e = {"id": "b1", "word": "tractor", "box": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}, "t": 3.0}
        self.assertEqual(len(S.merge_entries([], [e])), 1)

    def test_rejects_entry_without_any_anchor(self):
        self.assertEqual(S.merge_entries([], [{"id": "x", "word": "noanchor"}]), [])

    def test_rejects_empty_quote_exact(self):
        self.assertEqual(S.merge_entries([], [{"id": "x", "word": "w", "quote": {"exact": "   "}}]), [])

    def test_dedupes_quotes_by_exact(self):
        a = {"id": "q1", "word": "w", "quote": {"exact": "same text", "prefix": "a"}}
        b = {"id": "q2", "word": "w", "quote": {"exact": "same text", "prefix": "b"}}
        self.assertEqual(len(S.merge_entries([a], [b])), 1)

    def test_keeps_distinct_quotes_and_boxes(self):
        q = {"id": "q", "word": "w", "quote": {"exact": "one"}}
        b = {"id": "b", "word": "w", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, "t": 1.0}
        self.assertEqual(len(S.merge_entries([q], [b])), 2)

    def test_box_dedupe_still_by_iou(self):
        a = {"id": "b1", "word": "w", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, "t": 1.0}
        b = {"id": "b2", "word": "w", "box": {"x": 0.11, "y": 0.11, "w": 0.2, "h": 0.2}, "t": 1.1}
        self.assertEqual(len(S.merge_entries([a], [b])), 1)

    def test_keeps_wordless_tag_annotation(self):
        e = {"id": "t1", "tags": ["日语"], "label": "注釈", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, "t": 2.0}
        self.assertEqual(len(S.merge_entries([], [e])), 1, "纯标签/备注（无词）应被保留")

    def test_drops_annotation_without_any_content(self):
        e = {"id": "t2", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}
        self.assertEqual(len(S.merge_entries([], [e])), 0, "无词、无标签、无备注应被丢弃")

    def test_wordless_distinguished_by_label(self):
        a = {"id": "a", "label": "意见A", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, "t": 1.0}
        b = {"id": "b", "label": "意见B", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, "t": 1.0}
        self.assertEqual(len(S.merge_entries([a], [b])), 2, "无词时不同备注应视为不同标注")

    def test_render_note_video_has_time_columns(self):
        md = S.render_note("t", {"platform": "bilibili", "type": "video", "videoId": "bilibili:BV1"},
                           [{"word": "w", "t": 3, "dur": 1}], [], "", "2026-01-01T00:00:00")
        self.assertIn("时刻(s)", md)
        self.assertIn("type: video", md)

    def test_render_note_image_uses_anchor_column(self):
        md = S.render_note("t", {"platform": "generic", "type": "image", "mediaId": "img-1"},
                           [{"word": "w"}], [], "", "2026-01-01T00:00:00")
        self.assertIn("锚点", md)
        self.assertNotIn("时刻(s)", md)
        self.assertIn("type: image", md)

    def test_render_note_article_shows_quote_text(self):
        md = S.render_note("t", {"platform": "generic", "type": "article", "mediaId": "web:1"},
                           [{"word": "w", "quote": {"exact": "the tea was planted"}}], [], "", "2026-01-01T00:00:00")
        self.assertIn("the tea was planted", md)
        self.assertIn("锚点", md)


if __name__ == "__main__":
    unittest.main(verbosity=2)
