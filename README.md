# Graphen

**GraphRAG 知识图谱 Web 应用** — 上传文档，自动构建知识图谱，可视化探索，智能对话。

<p align="center">
  <strong>文档解析</strong> → <strong>知识图谱构建</strong> → <strong>可视化探索</strong> → <strong>智能对话</strong>
</p>

---

## ✨ 特性

- 📄 **文档解析** — 支持 Markdown、PDF、TXT 文档上传与自动解析
- 🧠 **知识图谱构建** — 利用 LLM 从文档中抽取实体和关系，自动构建结构化知识图谱
- 🌐 **交互式可视化** — 基于 Reagraph 的 2D 力导向图，支持点击、搜索、过滤、展开等交互
- 💬 **GraphRAG 对话** — 基于知识图谱 + 向量检索的增强对话，回答精准且带来源引用
- 🔌 **数据库抽象** — 当前使用 Neo4j，预留 SQL/PGQ 切换能力

## 🏗️ 技术栈

| 层 | 技术 |
|---|---|
| **前端** | React 19 + TypeScript + Vite |
| **UI** | Radix UI + Vanilla CSS + Framer Motion |
| **可视化** | Reagraph (2D Force Layout) |
| **状态管理** | Zustand |
| **后端** | Node.js + Express + TypeScript |
| **LLM** | Gemini / Qwen / OpenAI (OpenAI-compatible) |
| **图数据库** | Neo4j 5.x (Graph + Vector Index) |
| **Chat 存储** | SQLite (better-sqlite3) |
| **Monorepo** | pnpm workspace |

## 📁 项目结构

```
graphen/
├── packages/
│   ├── frontend/          # 前端 (React + Vite)
│   ├── backend/           # 后端 (Express + TypeScript)
│   └── shared/            # 前后端共享类型定义
├── data/                  # 本地运行时数据 (.gitignore)
├── docs/design/           # 设计文档
├── .env.example           # 环境变量模板
├── pnpm-workspace.yaml    # pnpm workspace 配置
└── tsconfig.base.json     # 共享 TypeScript 配置
```

---

## 🚀 本地启动指南

### 1. 环境要求

| 工具 | 版本要求 | 说明 |
|------|---------|------|
| **Node.js** | ≥ 18.x | 推荐使用 LTS 版本 (20.x / 22.x) |
| **pnpm** | ≥ 10.0 | 包管理器 (`npm install -g pnpm`) |
| **Neo4j** | ≥ 5.x | 图数据库 (本地安装或 Neo4j Aura Free Tier) |
| **LLM API Key** | — | Gemini, Qwen 或 OpenAI 的 API 密钥 |

### 2. 安装 Neo4j

选择以下任一方式：

**方式 A：本地安装（推荐）**

从 [Neo4j 官网](https://neo4j.com/download/) 下载 Neo4j Community Edition，安装后启动：

```bash
# macOS (Homebrew)
brew install neo4j
neo4j start
```

默认地址：`bolt://localhost:7687`，初始用户名/密码：`neo4j/neo4j`（首次登录需修改密码）。

**方式 B：Neo4j Aura Free Tier（免安装）**

访问 [Neo4j Aura](https://neo4j.com/cloud/aura-free/) 创建免费实例，获取连接 URI 和密码。

### 3. 克隆项目 & 安装依赖

```bash
git clone <repo-url>
cd graphen

# 安装所有依赖（前后端 + shared）
pnpm install
```

### 4. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入必要配置（详见下方 [配置说明](#-配置说明)）：

```bash
# ⚠️ 必须填写
LLM_PROVIDER=gemini # 或 qwen, openai
GEMINI_API_KEY=sk-xxxxxxxxxxxxxxxx
NEO4J_PASSWORD=your-neo4j-password

# 其余配置已有默认值，可按需调整
```

### 5. 启动开发服务器

```bash
# 一键启动前后端
pnpm dev
```

启动后访问：

| 服务 | 地址 |
|------|------|
| **前端** | http://localhost:5173 |
| **后端 API** | http://localhost:3001 |
| **健康检查** | http://localhost:3001/api/health |

> 💡 前后端均支持热重载 (HMR)，修改代码后自动刷新。

---

## ⚙️ 配置说明

所有配置通过项目根目录下的 `.env` 文件管理（基于 `.env.example` 模板）。

### 基础配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NODE_ENV` | `development` | 运行环境 |
| `PORT` | `3001` | 后端服务端口 |
| `CORS_ORIGIN` | `http://localhost:5173` | 允许的前端 CORS 来源 |
| `LOG_LEVEL` | `info` | 日志级别 (`debug` / `info` / `warn` / `error`) |

### LLM 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_PROVIDER` | `gemini` | LLM 供应商选择 (`gemini`, `qwen`, `openai`) |
| `GEMINI_API_KEY` | *(必填)* | Gemini API 密钥 |
| `QWEN_API_KEY` | *(必填)* | 通义千问 API 密钥 |
| `OPENAI_API_KEY` | *(必填)* | OpenAI API 密钥 |
| `EMBEDDING_DIMENSIONS` | `1024` | Embedding 向量维度（须与选中的模型匹配） |

> 💡 更多详细配置（如 `BASE_URL`, `MODEL_NAME`）请参考 `.env.example`。

### LLM 限流 & 容错

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_MAX_CONCURRENT` | `5` | 最大并发 LLM 请求数 |
| `LLM_MAX_RETRIES` | `3` | 请求失败最大重试次数 |
| `LLM_RETRY_DELAY_MS` | `1000` | 初始重试延迟（ms，指数退避） |
| `LLM_REQUESTS_PER_MINUTE` | `30` | 每分钟最大请求数 |
| `LLM_TIMEOUT_MS` | `60000` | 单次请求超时时间（ms） |

### Neo4j 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j 连接地址 |
| `NEO4J_USER` | `neo4j` | 数据库用户名 |
| `NEO4J_PASSWORD` | *(必填)* | 数据库密码 |
| `NEO4J_DATABASE` | `neo4j` | 数据库名称 |

### 文档处理配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_UPLOAD_SIZE` | `52428800` | 文件上传大小上限（字节，默认 50MB） |
| `CHUNK_SIZE` | `1500` | 文本分块大小（tokens） |
| `CHUNK_OVERLAP` | `200` | 分块重叠长度（tokens） |
| `MAX_CHUNKS_PER_DOCUMENT` | `500` | 单文档最大分块数 |
| `MAX_DOCUMENT_ESTIMATED_TOKENS` | `500000` | 单文档最大估算 token 数 |

### API 限流

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流时间窗口（ms） |
| `RATE_LIMIT_MAX` | `100` | 窗口内最大请求数 |

### 数据存储路径

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHAT_DB_PATH` | `data/chat.db` | SQLite 对话数据库路径 |
| `CACHE_DIR` | `data/cache` | 解析中间结果缓存目录 |

---

## 🧪 测试案例

项目在 [`/cases`](./cases) 目录下提供了一些简单的测试案例，方便快速上手：

- **Simple Finance**: 包含一组金融相关的 Markdown 文档（关系识别、市场事件、交易网络），适合测试图谱抽取的准确性和关联性。

你可以直接将这些文件上传到应用中，观察知识图谱的构建效果。

---

## 📜 可用脚本

从项目根目录执行：

```bash
# 启动开发服务器（前后端并行）
pnpm dev

# 构建所有包
pnpm build

# 类型检查
pnpm typecheck
```

单独操作某个包：

```bash
# 仅启动前端
pnpm --filter @graphen/frontend dev

# 仅启动后端
pnpm --filter @graphen/backend dev

# 后端测试
pnpm --filter @graphen/backend test

# 后端集成测试
pnpm --filter @graphen/backend test:integration
```

---

## 📄 License

MIT
