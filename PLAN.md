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

### RESOLVED: Mobile UI Responsiveness (FIX 2026-09-14)
**Symptom:** On real mobile devices, the main content area appeared blank — only the input bar was visible. Chat messages, panel header, and sidebar toggle were either hidden or pushed off-screen.

**Root Causes:**
1. `100vh` on mobile includes browser chrome (address bar, bottom bar), pushing content off-screen
2. Flex items (`.panel-terminal`, `.terminal-stream`) lacked `height: 0` to force proper flex sizing
3. Missing `-webkit-fill-available` fallback for iOS Safari
4. Missing `viewport-fit=cover` meta tag (required for `env(safe-area-inset-*)` to work)
5. **Android Go Edition uses older Chrome/WebView (often <108) where `100dvh` is NOT supported**

**Fixes Applied (`styles.css`, `index.html`, `app.js`):**
1. Added `-webkit-fill-available` and `100dvh` fallbacks for accurate viewport height
2. Changed `.panel-terminal` and `.terminal-stream` from `flex: 1` to `flex: 1 1 0` with `height: 0` — forces flex items to respect their computed bounds
3. Added `viewport-fit=cover` to `<meta name="viewport">`
4. Added `panel-terminal` safe-area padding for notch devices
5. Fixed 480px breakpoint sidebar `transform` to prevent ghost hit areas
6. **Added JS-based viewport height detection** — `window.innerHeight` provides the real viewport height on Android Go where CSS viewport units fail
7. Added `--app-height` CSS custom property set via JS, used as primary fallback in CSS
8. Added `touch-action: manipulation` to inputs/buttons (prevents double-tap zoom on Android Go)
9. Added `overscroll-behavior: none` (prevents pull-to-refresh interference)
10. Added `-webkit-tap-highlight-color: transparent` globally
11. Added `mobile-web-app-capable` and Apple meta tags
12. Added `-webkit-transform: translateZ(0)` to sidebar backdrop for GPU acceleration on low-end devices

---

## Pending Features & Improvements

### Testing Infrastructure (NOT STARTED)
**Priority:** High

**Current State:** Zero tests exist. No test framework, no test files, no CI/CD.

**Proposed Strategy:**

| Layer | Tool | Coverage |
|-------|------|----------|
| Backend unit tests | Jest + supertest | `agent.js` (tool execution), `sessions.js` (CRUD), WebSocket message routing |
| Frontend unit tests | Vitest | `CommandHistory`, `CodeViewer`, `Terminal` rendering, `Auth` token flow |
| E2E tests | Playwright | Login flow, session create/load/switch, mobile viewport rendering, sidebar toggle |
| Visual regression | Percy or Chromatic | Capture screenshots at 375px, 768px, 1024px, 1440px — detect layout drift |

**Test File Structure (proposed):**
```
tests/
├── backend/
│   ├── agent.test.js
│   ├── sessions.test.js
│   └── server.test.js
├── frontend/
│   ├── app.test.js
│   ├── terminal.test.js
│   └── auth.test.js
├── e2e/
│   ├── login.spec.js
│   ├── sessions.spec.js
│   └── mobile.spec.js
└── visual/
    └── regression.spec.js
```

**Action Items:**
- [ ] Add Jest + supertest to devDependencies
- [ ] Write backend unit tests for `sessions.js` CRUD operations
- [ ] Write backend unit tests for `agent.js` tool dispatch
- [ ] Add Playwright for E2E testing
- [ ] Write mobile viewport E2E test (verify terminal-stream renders at 375px)
- [ ] Set up CI pipeline (GitHub Actions) to run tests on push/PR

### Additional Improvement Areas
- **Error handling:** Agent `run_command` output truncation (currently returns full output)
- **Session search/filter:** No way to search through sessions by name or content
- **Keyboard shortcuts:** No shortcut to create new session or toggle code panel
- **Dark mode toggle:** Currently dark-only, could add light theme option
- **Mobile code viewer:** Currently hidden on mobile (`display: none`), could show as modal or swipeable panel

---

## Android Go Edition — Known Limitations

**Device:** Android 13 Go Edition (budget devices with ≤2GB RAM)
**Browser:** Chrome for Android Go (typically older version, may not receive latest updates)

### Web Rendering Issues Documented
| Issue | Description | Impact |
|-------|-------------|--------|
| CSS `100dvh` not supported | Chrome <108 doesn't support dynamic viewport units | Viewport height includes browser chrome, content pushed off-screen |
| Aggressive disk cache | `Cache-Control` headers often ignored | Stale CSS/JS served after deployment |
| PWA downloads broken | `beforeinstallprompt` event never fires | Cannot install as app |
| WebView caching layer | Some Android Go browsers have extra caching | Service workers may not clear cache properly |
| Limited RAM | ≤2GB RAM, aggressive tab killing | WebSocket connections may drop when tab is backgrounded |
| Older Chromium engine | May lack `gap` property, `container queries` | CSS features fail silently |

### Mitigation Strategies Used
1. **JS viewport detection** (`window.innerHeight`) as fallback for `100dvh`
2. **Touch action management** (`manipulation`) to prevent zoom issues
3. **Overscroll prevention** (`overscroll-behavior: none`) to avoid pull-to-refresh
4. **GPU acceleration hints** (`translateZ(0)`) for smooth animations on low-end hardware
5. **Content-hash filenames** (planned) to bypass aggressive caching

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
