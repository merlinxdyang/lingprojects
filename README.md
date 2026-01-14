# 语言学立项标题库：本地检索 + 选题评判 + 知识图谱（纯前端）

一个可直接打开的本地网页：`index.html`。支持本地检索、LLM 评审、知识图谱（关键词/题目关系）与导出报告。

## 功能一览
- 0. 数据加载：项目库、趋势桶、向量库
- 1. 检索：模糊/精确检索 + 年份与 pattern 过滤 + 可视化
- 2. 选题评判：联网调用 LLM，输出评审意见与备选题目
- 3. 知识图谱：关键词-题目关系、AI 语义分析、预计算概览
- 4. 图谱视图：可拖动节点、缩放/平移、点击高亮关联

## 快速开始
1. 双击打开 `index.html`
2. 在“0. 数据加载”选择：
   - `project.jsonl`（必选）
   - `trends.jsonl`（建议）
3. 点击“构建检索索引”
4. “1. 检索”输入关键词并检索
5. “2. 选题评判”输入拟题与 API Key（OpenRouter / OpenAI / Anthropic / DeepSeek）
6. “3. 知识图谱”加载向量资源并生成图谱

## 联网说明
- 前端库（Fuse.js / Chart.js / pako）需要联网加载
- LLM 调用需联网（推荐 OpenRouter）
- 本地数据全部通过“手动选择文件”读取，避免 file:// 跨域问题

## 数据文件
基础数据：
- `project.jsonl`：项目级记录（必选）
- `trends.jsonl`：趋势桶（建议）
- `vectors.jsonl`：包含 embedding 的向量数据库（用于知识图谱）

建议：`vectors.jsonl` 体积较大，推荐先做预处理。

## 知识图谱预处理（Python）
将 `vectors.jsonl` 预处理为轻量文件，加载速度更快：

```bash
python3 tools/preprocess_vectors.py --input vectors.jsonl --out .
```

输出文件：
- `metadata.json`：元数据（必选）
- `embeddings.gz`：向量压缩包（必选）
- `inverted-index.json`：倒排索引（可选）
- `graph.json`：预计算概览（可选）

在“3. 知识图谱”页面选择这些文件即可生成图谱。

## 知识图谱交互
- 拖动节点：布局会动态调整
- 拖动空白处：平移画布
- 滚轮：缩放（zoom in/out）
- 点击节点：仅显示与其直接相连的点/线，高亮并显示文字

## 备注
- AI 评判与图谱 AI 分析需要 OpenRouter Key
- 如果遇到 CORS 限制，可使用 OpenRouter 或本地代理方案
