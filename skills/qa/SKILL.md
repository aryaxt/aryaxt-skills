---
name: qa
description: Investigate a change or a bug report, drive the real app to see it (iOS via Appium, Android via adb + uiautomator, web via the browser, API via direct calls), screenshot every step along the way, then produce a beautiful self-contained HTML report — the path taken, every screen, plus class/DB diagrams when the code warrants — and open it in Chrome. In bug mode it also reproduces, root-causes, fixes, re-verifies (before/after), and hands the fix to /doit to ship. Use when the user types /qa, says "verify this works", "show me how it looks", "test the X flow", "qa this branch", "I found a bug …", "investigate why X is broken", or any variant of "make sure the UI actually works / prove this works".
---

# /qa — investigate, drive the app, and produce a visual walkthrough report

`/qa` does not write or run test code. It **understands the change, navigates the real app the way a user would, photographs every step, and writes up what it saw** as a comprehensive HTML report you can read top to bottom and actually understand how the feature behaves. It runs in two modes:

- **Verify mode** (default) — given the current branch's changes (or a named feature), figure out the user path to the affected UI, drive the app, screenshot each step, and report. This is what `/doit` calls before merge.
- **Bug mode** — given a bug description, investigate the code, reproduce the broken state on a device (with screenshots), find the root cause, implement the fix, re-drive to capture before/after, write the report, then **call `/doit`** to open the PR + review + merge. Report a bug, get a shipped fix with visual proof.

It auto-derives the navigation path from the code. There are **no hand-authored smoke-test steps** to maintain anymore (the old `## Visual smoke test` sections are optional hints, not a requirement).

---

## Step 1 — parse intent and pick the mode

```
ARG="$*"
```

- **Empty** → **verify mode** on the current branch diff (`git diff origin/main..HEAD`).
- **Reads like a malfunction** ("crashes when…", "X button does nothing", "wrong price shows", "it's not saving") → **bug mode**, `ARG` is the bug report.
- **Names a feature / screen / path** ("the upload menu", "create-model flow", "/admin") → **verify mode** targeting that.

When it's genuinely ambiguous whether the user is reporting a bug or asking to verify a feature, ask **one** short question. Otherwise proceed — don't interrogate.

State the chosen mode and target back in one line before doing anything: *"Verify mode — walking the upload-menu flow on iOS."* / *"Bug mode — investigating 'credits not deducted after edit'."*

## Step 2 — scope the surface(s)

A change can touch any combination of **iOS** (`ios/`), **Android** (`android/`), **web** (`src/app`, `src/components`), **admin** (`src/app/admin`), and **API/server** (`src/app/api`, `src/lib`). Determine which surface(s) the work actually touches:

- **Verify mode** → classify the diff (`git diff origin/main..HEAD --name-only`). Mirror `/doit` Step 5.5's per-surface regexes — only drive a surface the diff actually changed.
- **Bug mode** → from the bug description + a code investigation, decide where the bug lives and which surface reproduces it. A server bug may be reproducible by driving the client OR by hitting the endpoint directly — pick whichever shows the failure most clearly.

If multiple surfaces are affected, do each in its own report section. Don't let "tested on iOS" stand in for "tested on web."

## Step 3 — analyze the code and derive the path (the part that replaces authored steps)

Read the changed/relevant files and build a mental model of the flow **before touching a device**:

1. **Entry point → affected screen.** Trace how a user reaches the changed UI from app launch: which tab, which button opens which sheet, what state is required (logged in? has a model? has credits?). Write this out as a concrete numbered navigation plan — this is the script you'll execute on the device.
2. **What to assert.** For each step, decide what the screenshot should show to prove it works (a specific title, a new button, the sheet height, a badge count, an error card).
3. **Pre-conditions.** If the flow needs seeded state (a trained model, credits, a published post), note how to get there (an existing golden account, a debug menu action, a Firestore seed). Prefer reusing existing app state over fabricating it.
4. **Decide which diagrams to include** (authored in Step 6, rendered in the report):
   - **Class / interaction diagram** — when the changed code is non-trivial (several collaborating types, a new service, a provider/adapter, a state machine). A Mermaid `classDiagram` or `sequenceDiagram` of the real types involved, not a generic sketch.
   - **Database / schema diagram** — when the feature **adds or changes persisted data** (a new Firestore collection, new fields, new indexes, a Storage path). A Mermaid `erDiagram` of the collections + key fields + relationships, plus a note on the security-rules surface.
   - Skip diagrams for small/obvious changes — they should earn their place.

This step is where `/qa` earns its keep: it figures the path out itself, so you never have to write steps in a doc.

## Step 4 — set up the driver for each surface

Pick the right driver per platform. **Take a screenshot after every navigation action and every opened sheet** — those screenshots are the report.

### iOS → Appium (XCUITest)

1. Build + launch via the **`simulator` skill** (Skill tool, don't re-implement its bash) so the app is installed and current.
2. `select_device` → `prepare_ios_simulator` → `appium_session_management` (action=create). Capabilities come from `.claude/appium/capabilities.json` (attaches to the installed `com.shivaapps.photoai`, `noReset: true`).
3. Drive with `appium_get_page_source` (find real accessibility-ids / labels — **prefer stable locators over xpath**) → `appium_find_element` → `appium_gesture` (tap/scroll) / `appium_set_value` (type). Use `action=scroll_to_element` when a target is off-screen.
4. `appium_screenshot` returns base64 PNG — decode and save each into the report's `assets/` dir with a zero-padded ordinal + slug (`01-dashboard.png`, `02-upload-sheet.png`).
5. Tear the session down when done. **Leave the simulator running** — the user may be mid-test.

### Android → adb + uiautomator (no Appium)

Drive the emulator/device directly over `adb` (same approach as the `hinge-wingman` skill — lighter than standing up an Appium server):

- Launch / foreground: `adb shell monkey -p com.shivaapps.photoai -c android.intent.category.LAUNCHER 1`
- Inspect the view tree (real bounds + ids/text for locating, not pixel-guessing):
  `adb exec-out uiautomator dump /dev/tty` → parse the XML for the target node's `bounds`
- Tap / type / key: `adb shell input tap <x> <y>` · `adb shell input text "…"` · `adb shell input keyevent <KEY>`
- Screenshot each step: `adb exec-out screencap -p > assets/NN-slug.png`

Build + install first via `/simulator android` (or `/emulator`) so the build is current.

### Web / admin → the browser

Use the `preview_*` tools (or the `/chrome` skill) to boot the dev server and drive the affected flow. Screenshot each step with `preview_screenshot`. Check `preview_console_logs` / `preview_network` for errors and fold any into the report. (Admin lives at `/admin`.)

### API-only change → trigger it directly

When the change is server-only with no rendered surface (or you want to prove the endpoint independently):

- **Prefer driving the real client UI that calls the endpoint** when one exists — it proves the end-to-end behavior, and you capture both the screens and the network call (`preview_network` on web, the request/response on mobile).
- Otherwise **hit the endpoint directly** (curl / fetch) with a valid auth token, and capture the full **request and response** (method, path, headers sans secrets, body, status, response JSON) for the report. If the route needs App Check / admin, note how you satisfied it.

## Step 5 (bug mode only) — reproduce, root-cause, fix, re-verify

1. **Reproduce.** Drive the app to the failing state and screenshot it. If you can't reproduce, say so clearly and stop — don't fix a phantom.
2. **Root-cause.** From the code, identify *why* it breaks (not just where). Write a crisp root-cause statement for the report.
3. **Fix.** Implement the minimal correct fix. Follow the repo's conventions and the backward-compat gate (live production — no breaking server-contract / schema changes; if the only fix is breaking, STOP and surface it per AGENTS.md).
4. **Re-verify.** Re-drive the same path and capture the **after** screenshots. The report shows before (broken) vs after (fixed) side by side.

## Step 6 — build the HTML report

Write a **self-contained, beautiful** `report.html` into a gitignored per-run dir, with screenshots referenced from a sibling `assets/`:

```
.qa-reports/<YYYYMMDD-HHMMSS>-<slug>/
  report.html
  assets/01-….png  02-….png  …
```

Ensure `.qa-reports/` is gitignored (append it to the repo's `.gitignore` if missing — reports are local artifacts, never committed).

The report must let the user *understand how it was tested and see how the UI looked*. Structure:

1. **Header** — feature/bug title, mode, surfaces, branch, date, one-line verdict (✅ verified / ✅ fixed / ❌ failed).
2. **Summary** — 2-4 sentences: what was changed/broken, what was tested, the outcome.
3. **The path taken** — a numbered timeline. **Each step = its screenshot inline + a caption** describing the action and what the screenshot proves. This is the heart of the report; make it readable as a story.
4. **Before / after** (bug mode) — the broken state next to the fixed state.
5. **Diagrams** (when Step 3 flagged them) — render Mermaid via CDN (`https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js`, `mermaid.initialize({startOnLoad:true, theme:'dark'})`). Author real `classDiagram` / `sequenceDiagram` / `erDiagram` source from the actual code, with a sentence explaining each.
6. **API calls** (when triggered) — request + response, pretty-printed, secrets redacted.
7. **Root cause + fix** (bug mode) — the root-cause statement and a short summary of the change (link the touched files).
8. **Verdict / notes** — what passed, anything not covered, follow-ups.

**Styling:** dark, product-aligned (navy surface `#0B0B12`, raised `#15151F`, indigo accent `#6E66F0`, white headings, muted body). Generous radii, hairline borders, screenshots in rounded cards with a subtle border. It should look designed, not like a dump. Keep it one self-contained HTML file (inline CSS; Mermaid is the only CDN).

## Step 7 — open it in Chrome

```
open -a "Google Chrome" ".qa-reports/<dir>/report.html"
```

Tell the user the report path and give a 2-3 line spoken summary of the verdict. The HTML is the deliverable — don't recreate it in chat.

## Step 8 (bug mode with a fix) — hand off to /doit

If you made a code change, **invoke `/doit`** (Skill tool) to ship it. `/doit` owns branch + PR + multi-agent review + merge — `/qa` does **not** open its own PR. Pass `/doit` the context and **link the report** so it lands in the PR body (copy the report dir somewhere durable or attach the key screenshots). On a clean branch, `/doit` will create the branch; otherwise it splits/commits as usual.

Verify mode never auto-ships — it only reports.

---

## When NOT to use this skill

- **Performance / animation feel** — screenshots can't capture jank or frame drops. Drive the sim and screen-record instead (see `/doit` Step 5.5's animation note).
- **Real-device-only capabilities** — push, biometrics, camera, ARKit. Use `/device`.
- **Pure refactors / type-only / comment changes** with no observable behavior — there's nothing to walk; unit tests are the verification.

## Notes

- **Not a replacement for unit tests.** `/qa` covers what tests can't reach (real rendering, sheets, navigation, system overlays) and produces human-readable evidence. Anything testable headlessly should still be a Vitest / Swift Test.
- **Locate elements by id/label/bounds from the live view tree, never hardcoded coordinates** — window position and density vary.
- **First iOS/Android build is 2-3 min** (shared build cache with `/simulator`); subsequent runs are fast.
- **Don't shut the simulator/emulator down** when finished — the user may keep testing.
- A feature doc's `## Visual smoke test` section, if present, is a useful **hint** for the path — read it, but you're not bound to it and you don't need one to run.
