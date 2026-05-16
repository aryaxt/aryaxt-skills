---
name: chrome
description: Boot the local Next.js dev server (or reuse a running one) and open the app in Google Chrome on macOS so the user can test changes. Use whenever the user types /chrome, asks to "run the app in chrome", "open in chrome", "test in chrome", "fire up the app and let me see", "boot the dev server", or otherwise wants a working browser session for the current branch. If the user passes a path argument (e.g. /chrome /dashboard), open Chrome to that path; otherwise open the root.
---

# /chrome — boot the dev server and open in Chrome

Goal: the user wants to interact with the running app in Chrome with one command. Detect the dev server config, start it if needed, handle worktree env quirks, then open Chrome.

## Step 1 — figure out the dev server

Look for `.claude/launch.json` in the project root (`git rev-parse --show-toplevel`):

- **If found** with a `configurations` array: pick the first entry whose `name` does NOT contain `"preview"` (preview-suffixed configs exist for Claude's preview tool, not human testing). If every config has `"preview"` in its name, fall back to the first one.
- **If not found**: assume `npm run dev` on port `3000`.

Capture: `PORT`, the run command (`runtimeExecutable` + `runtimeArgs`), and the config `name`.

## Step 2 — fix worktree env (if applicable)

Worktrees don't inherit the parent repo's `.env.local`, but Firebase / Next.js load env at startup — a missing file crashes the app on first render.

```bash
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
# git-common-dir can come back relative ("../.git" or just ".git"); resolve to absolute
GIT_COMMON_ABS=$(cd "$WORKTREE_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
PARENT_REPO=$(dirname "$GIT_COMMON_ABS")

# Only act when (a) we're in a worktree, (b) worktree is missing .env.local, (c) parent has one
if [ "$PARENT_REPO" != "$WORKTREE_ROOT" ] && [ ! -e "$WORKTREE_ROOT/.env.local" ] && [ -f "$PARENT_REPO/.env.local" ]; then
  ln -s "$PARENT_REPO/.env.local" "$WORKTREE_ROOT/.env.local"
fi
```

If neither location has `.env.local`, skip — that's missing user config, not yours to fix. The app will surface its own error on first render.

## Step 3 — start the server (or reuse)

Check whether the port is already serving:

```bash
lsof -ti tcp:$PORT
```

If nothing is listening, skip ahead and start a fresh server.

If a process is listening, classify it before deciding what to do. **Always probe the running process** — the port being bound is not the same as the server being healthy. A wedged Next.js dev server (port bound but HTTP requests hang) is a real and recurring failure mode, especially after worktree rebases or hot-reload crashes.

The trick: a cold-starting Next.js dev server can take 15–30s to first-compile a real route, so probing `/` with a short timeout would falsely classify a legitimately-compiling server as hung. Probe a **static-asset path** instead — Next.js serves it without waiting on a route compile, so a healthy server responds in milliseconds and a wedged one fails fast.

```bash
# Identify the process on the port. lsof can return multiple PIDs (parent +
# workers) — the first is sufficient for classification. Use `comm=` to get
# the binary basename for matching; keep `command=` for human display.
PID=$(lsof -ti tcp:$PORT | head -n1)
PROC_BIN=$(ps -p "$PID" -o comm= 2>/dev/null)
PROC_FULL=$(ps -p "$PID" -o command= 2>/dev/null)

# Static-asset path responds immediately on a healthy server; a hung one
# never replies. 5s is plenty for the alive case and bounds the wait.
CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "http://localhost:$PORT/_next/static/chunks/" 2>/dev/null)

case "$CODE" in
  ""|000) STATE=hung ;;       # no TCP-level response — wedged or refused
  *)      STATE=responsive ;; # any HTTP code (incl. 404) means alive
esac
```

Two branches:

1. **STATE=responsive** — port is healthy. Confirm it's actually Next.js (`x-powered-by: Next.js` header on `curl -sI http://localhost:$PORT/`). If yes, reuse. If no, warn the user — they may have a different project's server on that port — and let them decide whether to proceed.

2. **STATE=hung** — the server is bound but unusable. Decide based on the binary:
   - **If `$PROC_BIN` is `next-server` (or `$PROC_FULL` matches `node.*next/dist/.*server`)** — this is OUR own dev server, wedged. **Kill it and restart.** The skill rule against killing servers you didn't start exists to preserve the user's other work; it doesn't apply when the server is a broken instance of the exact thing this skill manages, blocking the only port the skill can use. Tell the user what you did and why in the final confirmation message.
   - **Otherwise** — that's a foreign process that happens to share the port. Show the user the `ps` output (`$PROC_FULL`) and ask whether to kill it or use a different port. Do not kill it unilaterally.

Match against the binary basename or the `node.*next/dist/.*server` pattern, not loose substrings of the user's command line — an editor window titled "next dev" or a path like `/Users/foo/legacy-next-server/bin/run` could otherwise false-positive.

Bouncing a healthy server loses Fast Refresh state, so reuse is always preferred when STATE=responsive.

Otherwise, start a fresh server:

- **If the Claude_Preview MCP is loaded** and the launch.json config has a name: call `preview_start` with that name. Cleanest path because the server lifecycle is tracked through the conversation.
- **Otherwise**: run via Bash with `run_in_background: true`, e.g. `cd "$WORKTREE_ROOT" && npm run dev`. Capture the bash shell ID returned — you'll need it to read logs via the `BashOutput` tool if startup fails.

Wait until the port responds — bounded loop, not unbounded:

```bash
for i in $(seq 1 30); do
  curl -sf -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break
  # any HTTP response (even 5xx) means the socket is bound and we're up
  curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null | grep -qE '^[1-5]' && break
  sleep 1
done
```

If the loop exits without the server responding (you waited 30s and curl never got a code), read the dev-server log via `BashOutput` and show the user the actual error. Don't open Chrome to a broken server.

A server returning 5xx counts as "up but broken" — open Chrome anyway so the user can see the error page; surface the log alongside it.

## Step 4 — open Chrome

`URL_PATH` is the positional arg (e.g. `/dashboard` for `/chrome /dashboard`), or `/` if none. Don't name the variable `$PATH` — that's the executable search path and clobbering it breaks the rest of the shell session.

```bash
URL_PATH="${1:-/}"
open -a "Google Chrome" "http://localhost:$PORT$URL_PATH" || {
  echo "Couldn't open Google Chrome. Install it from https://www.google.com/chrome/ and re-run /chrome."
  exit 1
}
```

Chrome must be installed — don't fall back to Safari, Firefox, or `open <url>` (which uses the default browser). The skill is `/chrome` for a reason.

## Step 5 — confirm

One short sentence covering:
- The URL you opened
- Whether you reused a running server or started a fresh one
- If you symlinked `.env.local`, mention it (they'll want to know if they hit Firebase issues)

Example: *"Opened http://localhost:3000/dashboard in Chrome — reused the dev server already running on port 3000."*

Or: *"Started `npm run dev` on port 3000 and opened it in Chrome. Symlinked .env.local from the parent repo."*

Or (when a wedged Next.js process was killed): *"Detected a wedged Next.js dev server on port 3000 (bound but not responding to HTTP), killed it, and started a fresh one. Opened http://localhost:3000/ in Chrome."*

## Notes

- **Don't kill servers you didn't start** — with one exception. A wedged Next.js dev server holding the port (port bound, HTTP hangs) is fair game to kill: it's a broken instance of the exact thing this skill manages, blocking the only port the skill can use. Foreign processes (different project, unrelated tool) are still off-limits without explicit user approval.
- **Don't fall back to Safari, Firefox, or `open <url>`** (which uses the default browser). The skill is `/chrome` — open Chrome.
- This skill is for the dev/test loop only. It does not handle Firebase emulators, production builds, or remote environments — defer to the user for those.
