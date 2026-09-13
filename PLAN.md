# Hermes Web UI — Development Plan

## Current Status: Functional with Known Issues

### Core Features — COMPLETE
- [x] Secure WebSocket auth (token handshake, no query string)
- [x] Rate limiting, Helmet CSP, CORS, timing-safe comparison
- [x] Real-time streaming (status, code, text, error frames)
- [x] Session management (create, load, delete, rename)
- [x] Token usage tracking with context length percentage
- [x] Model switching (dropdown with OpenRouter models)
- [x] Command history (arrow keys)
- [x] Auto-reconnect on disconnect

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

---

## Known Issues

### CRITICAL: Mobile Browser Caching (PENDING FIX)
**Symptom:** After deploying updates, mobile browsers continue serving old cached versions of CSS/JS files despite multiple refreshes. Desktop works fine after hard refresh.

**Attempted Fixes:**
1. `maxAge: 0` on express.static
2. `?v=3` cache-busting query strings on all CSS/JS references
3. HTML meta tags: `Cache-Control: no-store, no-cache, must-revalidate`
4. Server middleware setting no-cache headers on `.html` responses
5. Service worker (`sw.js`) that clears all caches then unregisters
6. Version bumped from v2 to v3

**Status:** Issue persists on actual mobile devices. Works in mobile web simulator but not on real hardware. Needs further investigation.

**Possible Causes:**
- Aggressive browser disk cache (not cleared by HTTP headers)
- WebView caching layer (some Android browsers)
- Railway CDN/proxy caching static assets
- Service worker not executing properly on some browsers

**Next Steps:**
- Try content-hash-based filenames instead of query strings
- Investigate Railway's CDN caching behavior
- Consider deploying to a different platform to isolate the issue

---

## File Structure
```
truAutoBot/
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── package.json
├── server.js          (Express + WebSocket gateway)
├── agent.js           (OpenRouter agent brain)
├── sessions.js        (Session persistence)
├── public/
│   ├── index.html
│   ├── sw.js          (Cache-clearing service worker)
│   ├── css/styles.css
│   └── js/
│       ├── app.js
│       ├── auth.js
│       ├── terminal.js
│       └── ws-client.js
├── data/              (Volume mount point)
│   ├── sessions/      (JSON session files)
│   └── workspace/     (Agent working directory)
```

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| WEB_UI_PASSWORD | Yes | Auth token for WebSocket/API access |
| OPENROUTER_API_KEY | Yes | OpenRouter API key |
| OPENROUTER_MODEL | No | Default model (default: openai/gpt-4o) |
| GITHUB_TOKEN | No | GitHub PAT for clone/push |
| RAILWAY_TOKEN | No | Railway API token |
| WORKDIR | No | Agent working directory |
| ALLOWED_ORIGIN | No | CORS origin (default: localhost) |

## Railway Deployment
- **Volume mount:** `/app/data`
- **Build:** Dockerfile (not Nixpacks)
- **Port:** Set automatically by Railway

## Last Updated
2026-09-14
