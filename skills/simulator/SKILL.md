---
name: simulator
description: Build and launch the iOS app on a simulator. Use whenever the user types /simulator, says "run on simulator", "test on simulator", "fire it up on iphone/ipad", "launch the app on sim", "let me test on iphone", or any variant of "show it to me on iphone/ipad". Optional positional arg: iphone (default), ipad, or all. Opens Simulator.app first if it isn't already running. Mac (Designed for iPad) target isn't wired up yet — tell the user to use iphone or ipad if they ask for it.
---

# /simulator — build and run the iOS app on a simulator

The iOS app lives at `ios/DatingAIAssistant.xcodeproj` (scheme `DatingAIAssistant`, bundle id `com.shivaapps.photoai`). This skill builds for the requested target and launches the app on it.

## Step 1 — parse the target

Argument can be:
- `iphone` (default if none) — latest available iPhone simulator
- `ipad` — latest available iPad simulator
- `all` — runs both sequentially (not parallel; they share derived data and would race)
- `mac` — **not yet supported.** Tell the user it's a follow-up and ask them to pick `iphone` or `ipad`. (The "Designed for iPad" pipeline needs end-to-end verification before we wire it up.)

Anything else: treat as a literal simulator device name and pass through to the picker as the explicit name.

## Step 2 — pick the simulator UDID

Pick a sensible device for the requested family. Strategy: try a short ranked list of preferred names first; if none of those are installed, fall back to whatever the latest-OS device of that family is.

```bash
# Adjust PREFERRED list per family
# iPhone preference order: standard iPhone 17 first (user preference), then Pros, then previous gen
PREFERRED_IPHONE=("iPhone 17" "iPhone 17 Pro Max" "iPhone 17 Pro" "iPhone 16 Pro" "iPhone 16")
PREFERRED_IPAD=("iPad Pro 13-inch (M5)" "iPad Pro 13-inch (M4)" "iPad Air 13-inch (M4)" "iPad Pro 11-inch (M5)")

# Pick first preferred device that's installed, else fall back
pick_udid() {
  local family="$1"; shift
  local preferred=("$@")
  local devices_json
  devices_json=$(xcrun simctl list devices available --json)

  # Try preferred names first
  for name in "${preferred[@]}"; do
    local udid
    udid=$(echo "$devices_json" | jq -r --arg n "$name" '
      [.devices | to_entries | sort_by(.key) | reverse | .[].value[] | select(.name == $n) | .udid][0] // empty
    ')
    [ -n "$udid" ] && { echo "$udid"; return 0; }
  done

  # Fallback: any device of the family, latest OS first (sort runtime keys descending)
  echo "$devices_json" | jq -r --arg fam "$family" '
    [.devices | to_entries | sort_by(.key) | reverse | .[].value[] | select(.name | startswith($fam)) | .udid][0] // empty
  '
}

UDID=$(pick_udid "iPhone" "${PREFERRED_IPHONE[@]}")  # or "iPad" + PREFERRED_IPAD
```

If `$UDID` is empty: surface "no iPhone (or iPad) simulator installed — install one via Xcode → Settings → Platforms" and stop. Don't fall back to a different family.

## Step 3 — open Simulator.app

```bash
pgrep -x Simulator >/dev/null || open -a Simulator
```

If it's already running, skip — re-opening brings it forward but doesn't hurt.

## Step 4 — boot the device

```bash
xcrun simctl boot "$UDID" 2>&1 | grep -v "Unable to boot device in current state: Booted" || true
```

The grep hides only the "already booted" complaint. Real errors (deleted runtime, corrupt sim) still surface.

## Step 5a — fix worktree saas-template symlink (if applicable)

iOS SPMs from `saas-template` (`Components`, `ErrorReporting`, `AppCheckProvider`, `PushNotifications`, …) are wired in `ios/project.yml` as `path: ../../saas-template/packages/<Name>`. That path resolves from the main repo (`~/Desktop/Repos/DatingAIAssistant/ios/` → `~/Desktop/Repos/saas-template/...`), but **NOT from a worktree** (`.claude/worktrees/<name>/ios/` → `.claude/worktrees/saas-template/...` which doesn't exist).

Symlink the worktree-peer location to the real saas-template before `xcodegen` runs, otherwise it errors with `Invalid local package "Components"` and friends.

```bash
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
GIT_COMMON_ABS=$(cd "$WORKTREE_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
PARENT_REPO=$(dirname "$GIT_COMMON_ABS")

# Only act when (a) we're in a worktree, (b) parent's sibling saas-template exists,
# (c) worktree-peer symlink is missing
if [ "$PARENT_REPO" != "$WORKTREE_ROOT" ]; then
  SAAS_SOURCE="$(dirname "$PARENT_REPO")/saas-template"
  SAAS_PEER="$(dirname "$WORKTREE_ROOT")/saas-template"
  if [ -d "$SAAS_SOURCE" ] && [ ! -e "$SAAS_PEER" ]; then
    ln -s "$SAAS_SOURCE" "$SAAS_PEER"
  fi
fi
```

If `$SAAS_SOURCE` doesn't exist, skip — the user doesn't consume saas-template SPMs and `xcodegen` will fail loudly with a clearer message than we could produce.

## Step 5 — ensure the Next.js dev server is up on port 3000

Debug iOS builds hit `http://localhost:3000` for the backend. Make sure a dev server is alive there with **the current worktree's code** and **the current env/config**, but don't restart unnecessarily — Next.js HMR already handles code changes, and a needless restart costs ~3-5s of churn.

The decision tree below covers four cases. Apply it in order; stop at the first match.

### Case A — nothing bound to :3000

```bash
PID=$(lsof -ti :3000 2>/dev/null || true)
```

If `PID` is empty, just start fresh: `npm run dev` in background, wait for "Ready" (poll output for `"Ready in"` or `"Local:"`), proceed to Step 6.

### Case B — :3000 bound by something that ISN'T a Next.js dev server

```bash
CMD=$(ps -p "$PID" -o command= 2>/dev/null || true)
```

If `CMD` doesn't match `next dev` (or `node ... next/dist/.../start-server.js`), it's foreign — kill it and start fresh:

```bash
kill -9 "$PID" 2>/dev/null || true
for _ in 1 2 3 4 5 6; do lsof -ti :3000 >/dev/null 2>&1 || break; sleep 0.5; done
npm run dev   # background
```

### Case C — Next.js dev server, but running from a different working directory

The current process might be a dev server from a different worktree / branch. Compare its `cwd` to ours:

```bash
PROC_CWD=$(lsof -p "$PID" -a -d cwd -F n 2>/dev/null | grep '^n' | head -1 | sed 's/^n//')
```

If `PROC_CWD` differs from the current shell's `pwd`, kill + restart (same commands as Case B). Foreign code, wrong env, etc.

### Case D — Next.js dev server, OUR worktree's cwd

Almost always the happy path — HMR has been picking up code changes. Restart only if a file Next.js DOESN'T live-reload has been modified since the server started:

| File | Why a restart is needed when it changes |
|---|---|
| `.env.local`, `.env`, `.env.development*` | Next.js reads env at boot |
| `next.config.ts` / `.js` / `.mjs` | Bundler config; HMR can't apply it |
| `package.json` | New deps or scripts |
| `middleware.ts` / `proxy.ts` | Route-level handlers loaded at boot |
| `instrumentation.ts` | Loaded at boot |

```bash
# Server start time as epoch seconds. Normalize multiple spaces in ps output.
LSTART=$(ps -p "$PID" -o lstart= | tr -s ' ')
SERVER_EPOCH=$(date -j -f "%a %b %e %T %Y" "$LSTART" +%s 2>/dev/null || echo 0)

NEED_RESTART=0
for f in .env.local .env .env.development .env.development.local next.config.ts next.config.js next.config.mjs package.json middleware.ts proxy.ts instrumentation.ts; do
  [ -f "$f" ] || continue
  FILE_EPOCH=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)
  [ -n "$FILE_EPOCH" ] && [ "$FILE_EPOCH" -gt "$SERVER_EPOCH" ] && { NEED_RESTART=1; STALE_FILE="$f"; break; }
done

if [ "$NEED_RESTART" = "1" ]; then
  echo "Restarting dev server — $STALE_FILE changed since it started"
  kill -9 "$PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do lsof -ti :3000 >/dev/null 2>&1 || break; sleep 0.5; done
  npm run dev   # background
else
  echo "Reusing dev server on :3000 (PID $PID) — HMR has the latest"
fi
```

If `SERVER_EPOCH` ends up `0` (date parse failed), default to restart — fail safe, not fast.

### After any branch above

If a fresh `npm run dev` was started, **wait for "Ready"** before launching the app in Step 7. The build (Step 6) is allowed to run in parallel, but Step 7 must not race a cold-starting server. Poll the background task's output for `"Ready in"` or `"Local:"`.

If the dev server fails to come up (missing `.env.local`, dependency drift, port still bound after kill), surface the actual error from its log and stop. Don't try to "fix" it autonomously — the iOS app will just 404 against a dead server and the user will be confused.

## Step 6 — build

Use a stable derived-data path so successive runs hit the cache. Run in background — first build is 2–3 min (SwiftPM resolution), subsequent are 10–30s.

```bash
xcodebuild \
  -project ios/DatingAIAssistant.xcodeproj \
  -scheme DatingAIAssistant \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath /tmp/datingai-sim-build \
  build
```

If the build fails, surface the actual error from the log — don't try to "fix" it without showing the user. Common failures: code signing (open Xcode once to refresh), SwiftPM timeout (retry), or a real Swift compile error introduced by recent changes.

## Step 7 — install and launch

```bash
APP=$(find /tmp/datingai-sim-build/Build/Products/Debug-iphonesimulator -maxdepth 2 -type d -name "DatingAIAssistant.app" | head -1)
[ -z "$APP" ] && { echo "Build succeeded but .app not found at expected path"; exit 1; }
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" com.shivaapps.photoai
```

`-maxdepth 2` comes before `-name` for portability (GNU `find` requires options first; macOS BSD `find` is flexible but the documented form is options-first).

## Step 8 — confirm

One short sentence per target launched. Include the device name so the user knows which sim got it:

> *"Launched DatingAIAssistant on iPhone 17 Pro (iOS 26.4 simulator)."*

For `all`, log progress per device as each finishes — users want to see two lines on a 2-build run, not silence then a single message at the end.

## Notes

- **Don't shut down a booted simulator when done.** The user is mid-test.
- **Bundle ID is `com.shivaapps.photoai`** — read from `ios/project.yml`'s `PRODUCT_BUNDLE_IDENTIFIER`. If that ever changes, update this skill.
- **Mac (Designed for iPad) is intentionally unsupported in this version.** The right destination is `platform=macOS,variant=Designed for iPad`, the build emits to `Debug-iphoneos/`, and `open` *should* launch the resulting bundle as a Mac-runnable app — but that pipeline needs end-to-end verification on this project before being trusted in a one-command skill. Add it in a follow-up after testing.
- **First build dominates.** SwiftPM resolves Firebase/GoogleSignIn from scratch on a clean derived-data dir. The shared `/tmp/datingai-sim-build` dir keeps subsequent runs fast. Note: `/tmp` on macOS is preserved across reboots but purged after 3 days of file inactivity by `periodic`, so a long gap between runs may force a clean rebuild.
- **Don't use the Xcode MCP's `BuildProject`** for this — it builds for whatever destination Xcode last had selected, which isn't deterministic for this skill's targets. Use `xcodebuild` with explicit `-destination`.
- **Port 3000 is reused when safe, killed when not.** Step 5's decision tree reuses an existing dev server if it's ours and HMR is sufficient (no env/config/middleware changes since it started). It kills + restarts only when the process is foreign, from another worktree, or running against stale env/config. If a future user wants force-restart, add a `--restart-dev` arg parser at Step 1.
