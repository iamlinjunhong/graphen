# Graphen

**GraphRAG Knowledge Graph Web App** — Upload documents, automatically build knowledge graphs, visually explore, and chat with AI.

<p align="center">
  <strong>Document Parsing</strong> → <strong>Knowledge Graph Construction</strong> → <strong>Visual Exploration</strong> → <strong>AI Chat</strong>
</p>

---

## ✨ Features

- 📄 **Document Parsing** — Upload and automatically parse Markdown, PDF, and TXT documents
- 🧠 **Knowledge Graph Construction** — Extract entities and relationships from documents using LLM, automatically building a structured knowledge graph
- 🌐 **Interactive Visualization** — 2D force-directed graph powered by Reagraph with click, search, filter, and expand interactions
- 💬 **GraphRAG Chat** — Enhanced conversational AI using knowledge graph + vector retrieval, with accurate answers and source citations
- 🔌 **Database Abstraction** — Currently uses Neo4j, with a reserved ability to switch to SQL/PGQ

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19 + TypeScript + Vite |
| **UI** | Radix UI + Vanilla CSS + Framer Motion |
| **Visualization** | Reagraph (2D Force Layout) |
| **State Management** | Zustand |
| **Backend** | Node.js + Express + TypeScript |
| **LLM** | Gemini / Qwen / OpenAI (OpenAI-compatible) |
| **Graph Database** | Neo4j 5.x (Graph + Vector Index) |
| **Chat Storage** | SQLite (better-sqlite3) |
| **Monorepo** | pnpm workspace |

## 📁 Project Structure

```
graphen/
├── packages/
│   ├── frontend/          # Frontend (React + Vite)
│   ├── backend/           # Backend (Express + TypeScript)
│   └── shared/            # Shared type definitions
├── cases/                 # Sample test cases
├── data/                  # Local runtime data (.gitignore)
├── .env.example           # Environment variable template
├── pnpm-workspace.yaml    # pnpm workspace config
└── tsconfig.base.json     # Shared TypeScript config
```

---

## 🚀 Getting Started

### 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | ≥ 18.x | LTS version recommended (20.x / 22.x) |
| **pnpm** | ≥ 10.0 | Package manager (`npm install -g pnpm`) |
| **Neo4j** | ≥ 5.x | Graph database (local install or Neo4j Aura Free Tier) |
| **LLM API Key** | — | API key for Gemini, Qwen, or OpenAI |

### 2. Install Neo4j

Choose one of the following methods:

**Option A: Local Installation (Recommended)**

Download Neo4j Community Edition from [neo4j.com](https://neo4j.com/download/), then start:

```bash
# macOS (Homebrew)
brew install neo4j
neo4j start
```

Default address: `bolt://localhost:7687`, initial username/password: `neo4j/neo4j` (you'll be prompted to change the password on first login).

**Option B: Neo4j Aura Free Tier (No Installation)**

Visit [Neo4j Aura](https://neo4j.com/cloud/aura-free/) to create a free instance and obtain the connection URI and password.

### 3. Clone & Install Dependencies

```bash
git clone <repo-url>
cd graphen

# Install all dependencies (frontend + backend + shared)
pnpm install
```

### 4. Configure Environment Variables

```bash
cp .env.example .env
```

Edit the `.env` file with the required settings (see [Configuration](#%EF%B8%8F-configuration) below):

```bash
# ⚠️ Required
LLM_PROVIDER=gemini # or qwen, openai
GEMINI_API_KEY=sk-xxxxxxxxxxxxxxxx
NEO4J_PASSWORD=your-neo4j-password

# Other settings have default values, adjust as needed
```

### 5. Start the Development Server

```bash
# Start frontend and backend
pnpm dev
```

Once started, visit:

| Service | URL |
|---------|-----|
| **Frontend** | http://localhost:5173 |
| **Backend API** | http://localhost:3001 |
| **Health Check** | http://localhost:3001/api/health |

> 💡 Both frontend and backend support Hot Module Replacement (HMR) — changes are reflected immediately.

---

## ⚙️ Configuration

All configuration is managed via the `.env` file in the project root (based on the `.env.example` template).

### General

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Runtime environment |
| `PORT` | `3001` | Backend server port |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed frontend CORS origin |
| `LOG_LEVEL` | `info` | Log level (`debug` / `info` / `warn` / `error`) |

### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `gemini` | LLM provider (`gemini`, `qwen`, `openai`) |
| `GEMINI_API_KEY` | *(required)* | Gemini API key |
| `QWEN_API_KEY` | *(required)* | Qwen API key |
| `OPENAI_API_KEY` | *(required)* | OpenAI API key |
| `EMBEDDING_DIMENSIONS` | `1024` | Embedding vector dimensions (must match the selected model) |

> 💡 For additional settings like `BASE_URL` and `MODEL_NAME`, refer to `.env.example`.

### LLM Rate Limiting & Resilience

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MAX_CONCURRENT` | `5` | Max concurrent LLM requests |
| `LLM_MAX_RETRIES` | `3` | Max retries on request failure |
| `LLM_RETRY_DELAY_MS` | `1000` | Initial retry delay in ms (exponential backoff) |
| `LLM_REQUESTS_PER_MINUTE` | `30` | Max requests per minute |
| `LLM_TIMEOUT_MS` | `120000` | Per-request timeout in ms |

### Neo4j

| Variable | Default | Description |
|----------|---------|-------------|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| `NEO4J_USER` | `neo4j` | Database username |
| `NEO4J_PASSWORD` | *(required)* | Database password |
| `NEO4J_DATABASE` | `neo4j` | Database name |

### Document Processing

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_UPLOAD_SIZE` | `52428800` | Max file upload size in bytes (default 50 MB) |
| `CHUNK_SIZE` | `1500` | Text chunk size (tokens) |
| `CHUNK_OVERLAP` | `200` | Chunk overlap length (tokens) |
| `MAX_CHUNKS_PER_DOCUMENT` | `500` | Max chunks per document |
| `MAX_DOCUMENT_ESTIMATED_TOKENS` | `500000` | Max estimated tokens per document |

### API Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit time window in ms |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |

### Data Storage Paths

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_DB_PATH` | `data/chat.db` | SQLite chat database path |
| `CACHE_DIR` | `data/cache` | Parsing intermediate result cache directory |

---

## 🧪 Test Cases

The project provides sample test cases in the [`/cases`](./cases) directory for quick experimentation:

- **Simple Finance**: A set of finance-related Markdown documents (relationship identification, market events, transaction networks), suitable for testing graph extraction accuracy and connectivity.

You can upload these files directly into the app to observe the knowledge graph being built.

---

## 📜 Available Scripts

Run from the project root:

```bash
# Start dev server (frontend + backend in parallel)
pnpm dev

# Build all packages
pnpm build

# Type checking
pnpm typecheck
```

Operate on individual packages:

```bash
# Frontend only
pnpm --filter @graphen/frontend dev

# Backend only
pnpm --filter @graphen/backend dev

# Run backend tests
pnpm --filter @graphen/backend test

# Run backend integration tests
pnpm --filter @graphen/backend test:integration
```

---

## 📄 License

MIT LICENSE
