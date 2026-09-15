# Hermes Web UI — Development Plan

## Current Status: Functional with HTTP Long-Poll Transport

### Core Features — COMPLETE
- [x] Secure auth (token handshake, timing-safe comparison)
- [x] Rate limiting, Helmet CSP, CORS
- [x] Real-time streaming via HTTP long-polling (status, code, text, error frames)
- [x] Session management (create, load, delete, rename with edit button)
- [x] Session animations (slide-in, delete slide-out, rename flash, toast notifications)
- [x] Current session name displayed in terminal header
- [x] Token usage tracking with context length percentage
- [x] Model switching (dropdown with OpenRouter models)
- [x] Command history (arrow keys)
- [x] Auto-reconnect on disconnect (exponential backoff)
- [x] CSS `!important` on `.hidden` class (fixes specificity override)

### Agent Brain — COMPLETE
- [x] OpenRouter API integration with function calling
- [x] Tools: read_file, write_file, edit_file, list_files, run_command
- [x] Tools: clone_repo, git_push, install_deps
- [x] Network retry (3 attempts with exponential backoff)
- [x] Dynamic context length from OpenRouter /api/v1/models
- [x] Collapsible thinking steps in UI
- [x] GitHub token injection for private repos
- [x] Clean malformed messages from session history

### Infrastructure — COMPLETE
- [x] Dockerfile with git, bash, curl
- [x] Single volume at /app/data (sessions + workspace)
- [x] Auto-cleanup of empty sessions on startup
- [x] Health endpoint at /health
- [x] HTTP long-polling transport (replaces WebSocket — Railway proxy incompatible)
- [x] Message queue per connection with stale connection cleanup
- [x] Server-side log buffer (last 200 entries)

### Debug & Diagnostics — COMPLETE
- [x] In-app debug panel (tap ⚡ icon in terminal header)
- [x] Client-side console capture (log/error/warn + window.onerror)
- [x] Server-side log streaming (polled every 5s)
- [x] Diagnostics endpoint (uptime, memory, connections, session info)
- [x] Copy-to-clipboard with full formatted log export
- [x] Filter by All/Errors/Warnings/Info
- [x] Railway API log viewer (browse projects → services → fetch logs)
- [x] Token type detection (account/workspace/project)
- [x] Toast notifications for session operations

### Railway Integration — COMPLETE
- [x] Railway API proxy (projects, services, logs endpoints)
- [x] Token type detection with fallback queries
- [x] Workspace-based project listing (me.workspaces → workspace.projects)
- [x] Deployment log fetching via deploymentLogs query

---

## Transport Architecture (HTTP Long-Polling)

### Why Not WebSocket/SSE
Railway's reverse proxy **kills WebSocket connections within seconds** and **buffers SSE responses** so the client never receives data. Neither works on Railway.

### How It Works
```
Client                          Server
  │                                │
  ├── POST /api/auth ──────────────┤  → Get connectionId, queue initial data
  │                                │
  ├── GET /api/poll?cid=... ───────┤  → Long-poll (25s hold, 200ms check)
  │←── { messages: [...] } ────────┤  → Returns when data available or timeout
  │                                │
  ├── POST /api/send ──────────────┤  → Process commands, queue responses
  │                                │
  └── GET /api/poll (repeat) ──────┤  → Next batch of messages
```

### Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth` | POST | Login, get connectionId, queue initial data |
| `/api/poll` | GET | Long-poll for messages (25s timeout) |
| `/api/send` | POST | Send commands/session operations |
| `/api/logs` | GET | Server log buffer (for debug panel) |
| `/api/diag` | GET | Server diagnostics |
| `/api/railway/projects` | GET | List Railway projects |
| `/api/railway/services` | GET | List services in a project |
| `/api/railway/logs` | GET | Fetch deployment logs |
| `/api/railway/token-info` | GET | Detect token type |
| `/health` | GET | Health check |

---

## Debug Panel Usage

### Opening
- Tap the **⚡ icon** in the terminal header
- Or **triple-tap** the connection status dot (●)

### Features
| Tab | What It Shows |
|-----|---------------|
| **Local Logs** | Client console + server logs, filterable by level |
| **Railway** | Browse projects → services → fetch deployment logs |

### Copy Output Format
```
=== Hermes Debug Log — <date> ===
Entries: N + M Railway

[time] [LEVEL] [client/server] message
...

--- RAILWAY LOGS ---
[time] [source] log line
...

--- DIAGNOSTICS ---
{ "uptime": 342, "memoryMB": 84, ... }
```

---

## Known Issues

### RESOLVED: WebSocket Connection Loop → Replaced with HTTP Long-Polling
**Root Cause:** Railway's reverse proxy kills WebSocket connections within seconds (code 1005/1006). Protocol-level `ws.ping()` blocked by proxy. SSE responses buffered and never delivered to client.

**Solution:** Replaced WebSocket entirely with HTTP long-polling. Standard HTTP works through any proxy. Message queue per connection, 25s poll timeout, 200ms check interval.

### RESOLVED: CSS Specificity Bug
**Root Cause:** `.hidden { display: none }` and `.overlay { display: flex }` had equal specificity (0,1,0). Since `.overlay` came later in the stylesheet, it always won — login overlay was never actually hidden.

**Fix:** `.hidden { display: none !important; }`

### RESOLVED: Service Worker Reload Loop
**Root Cause:** `sw.js` called `self.clients.claim()` which stole control of the page mid-load, re-triggering `DOMContentLoaded` → `connect()` → duplicate auth cycles.

**Fix:** Service worker now only unregisters existing workers. No new registration.

### RESOLVED: Console Log Feedback Loop
**Root Cause:** `console.log` interception created infinite loop: intercepted → buffer → console.log → intercepted again. Plus poll logging generated 5+ msgs/sec hitting Railway's 500 logs/sec limit.

**Fix:** Removed console interception. Server uses targeted `serverLog()` calls for key events only.

---

## File Structure
```
truAutoBot/
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── package.json
├── PLAN.md
├── server.js          (Express + HTTP long-poll gateway)
├── agent.js           (OpenRouter agent brain)
├── sessions.js        (Session persistence + log buffer)
├── public/
│   ├── index.html
│   ├── sw.js          (No-op, just unregisters old workers)
│   ├── css/styles.css
│   └── js/
│       ├── app.js     (UI controller, session rendering, debug trigger)
│       ├── auth.js    (Token management, login/dashboard transitions)
│       ├── terminal.js (Chat log rendering)
│       ├── ws-client.js (HTTP long-poll transport)
│       ├── debug.js   (Debug panel, console capture, Railway viewer)
│       └── sw-register.js (Unregisters old service workers)
├── data/
│   ├── sessions/      (JSON session files)
│   └── workspace/     (Agent working directory)
```

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| WEB_UI_PASSWORD | Yes | Auth token for API access |
| OPENROUTER_API_KEY | Yes | OpenRouter API key |
| OPENROUTER_MODEL | No | Default model (default: openai/gpt-4o) |
| GITHUB_TOKEN | No | GitHub PAT for clone/push |
| RAILWAY_TOKEN | Yes (for Railway tab) | Railway API token (account token recommended) |
| WORKDIR | No | Agent working directory |
| ALLOWED_ORIGIN | No | CORS origin (default: localhost) |

## Railway Deployment
- **Volume mount:** `/app/data`
- **Build:** Dockerfile (not Nixpacks)
- **Port:** Set automatically by Railway
- **Token type:** Account token (select "No workspace" when creating)

## Last Updated
2026-09-15
