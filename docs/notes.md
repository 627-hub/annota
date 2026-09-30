# 笔记导出（Obsidian / Notebook）+ 数据沉淀

在 `🤖 豆包` 面板点 **`📝 存笔记`**：把**当前视频的截图 + 标注词表 + 与豆包的对话**写成一篇 Markdown，
同时把「标注 + 对话」追加进 `data.jsonl`（**数据沉淀**，为终局模型备料）。

## 输出
```
<NOTES_DIR>/
├── 2026-09-30_bilibili_BVxxxx.md      # 一篇笔记（Obsidian 直接可读）
├── 2026-09-30_bilibili_BVxxxx/shot.png # 该笔记的截图
└── data.jsonl                          # 每行一条 {media, entries, chat, note}
```
笔记结构：YAML frontmatter（title/source/media/platform/created/tags）+ 截图 + `## 生词（标注）` 表 + `## 与豆包对话`。

## 接 Obsidian
把输出目录指到你的库（重启服务生效）：
```bash
export NOTES_DIR="$HOME/Documents/ObsidianVault/video-annotate"
python3 dev/hub.py
```
Obsidian 会自动收录新 `.md`；截图以相对路径嵌入。Notebook（Jupyter）同理可读 Markdown/PNG。

## 接口
| 方法 | 路径 | 体 | 返回 |
|---|---|---|---|
| POST | `/api/note` | `{title, media, entries, chat, screenshot(dataURL)}` | `{ok, path, dir}` |

## 为什么这么做（对齐项目终局）
- **标注数据收集**：`entries` 落 `data.jsonl` → word↔region 数据集（JEV 式决策模型的燃料）。
- **对话真题数据收集**：`chat` 一并落盘 → 后续可做「陪练语料/评测集」。
- **学科扩展**：同一套「截图 + 结构化知识点 + 问答」模板，换词表/学科即可复用。
