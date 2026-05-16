---
name: qa
description: Run a per-feature visual smoke test on the iOS simulator by driving it via computer-use. Use when the user types /qa, says "run the visual smoke test", "verify on simulator", "test the LA flow visually", "drive the simulator to check X", or any variant of "make sure the UI actually works". Optional positional arg: a feature name matching a file under `docs/features/<feature>.md` (e.g. `/qa live-activities`). With no arg, lists available features and asks which to run. Each feature's smoke test is defined in its `## Visual smoke test` section — the skill reads that and follows the steps.
---

# /qa — drive the iOS simulator to verify a visual feature

This skill mechanizes the workflow we built for Live Activities: build the iOS app, launch it on a simulator, drive the UI via computer-use, and verify visual states (lock screen, Dynamic Island, modals, onboarding cards, AOD, etc.) by taking screenshots between steps.

The verification flow is **defined per feature** in `docs/features/<feature>.md` under a `## Visual smoke test` section. The skill is just an orchestrator — it doesn't know what each feature looks like. Whoever ships a UI-affecting feature documents the steps in that section.

## Step 1 — parse the argument

```bash
ARG="$1"
if [ -z "$ARG" ]; then
  # No feature specified — list available ones
  echo "Available features with smoke tests:"
  /usr/bin/grep -l "^## Visual smoke test" docs/features/*.md 2>/dev/null \
    | /usr/bin/sed 's|docs/features/||;s|\.md||' \
    | /usr/bin/awk '{print "  - " $0}'
  echo ""
  echo "Run: /qa <feature-name>"
  exit 0
fi

FEATURE_DOC="docs/features/${ARG}.md"
if [ ! -f "$FEATURE_DOC" ]; then
  echo "No doc found at $FEATURE_DOC."
  echo "Create one with a '## Visual smoke test' section, then re-run."
  exit 1
fi

# Extract just the smoke-test section (between the heading and the next ## or EOF).
# Heading match is case-insensitive so "Visual smoke test" / "Visual Smoke Test"
# both work — saves a debugging detour when someone writes title case.
# tolower() is portable across BSD awk (macOS) and GNU awk; IGNORECASE is GNU-only.
STEPS=$(/usr/bin/awk '
  tolower($0) ~ /^## visual smoke test/ {flag=1; next}
  /^## / && flag {exit}
  flag {print}
' "$FEATURE_DOC")

if [ -z "$STEPS" ]; then
  echo "$FEATURE_DOC has no '## Visual smoke test' section. Add one and re-run."
  exit 1
fi

echo "=== Smoke test for $ARG ==="
echo "$STEPS"
```

If the feature doc doesn't exist or has no smoke-test section, surface the problem and stop. **Don't make up steps.** The doc is the source of truth.

## Step 2 — request computer-use access

The skill drives the simulator by sending clicks and key presses. Request access to the **Simulator** app via the computer-use MCP. Surface the reason clearly so the user knows what's about to happen:

> "About to drive the iOS simulator to run the **`<feature>`** smoke test. Steps come from `docs/features/<feature>.md`."

If the user denies, stop.

## Step 3 — make sure the app is built and launched

**Invoke the `simulator` skill directly via the Skill tool** (don't re-implement its bash). That skill picks an iPhone simulator, boots it, builds at `<your-app-sim-build-cache>` (shared cache with `/simulator`), and installs + launches `<your-bundle-id>`.

After `simulator` returns, ensure Simulator.app is the frontmost macOS application — computer-use's tier check requires it before any click is accepted. If it isn't, call `open_application` with `Simulator` to bring it forward.

If the build fails, surface the error and stop; don't try to verify a stale build.

## Step 4 — walk the steps from the doc

The smoke-test section is markdown. Each step is either:

1. **An action** — e.g., "Tap the menu icon (top-right)", "Cmd+L to lock", "Long-press the Dynamic Island"
2. **A verification** — e.g., "Verify: lock screen shows title + subtitle", "Verify: Dynamic Island compact has sparkle icon"

Walk the list:
- For action steps: send the equivalent computer-use input (`left_click`, `key`, `mouse_move`+`left_mouse_down`/`left_mouse_up` for long-press)
- For verification steps: take a screenshot, inspect it, mark ✅ or ❌. **On any ❌, stop, screenshot the unexpected state, summarize what was expected vs. seen, and ask the user before continuing — failures often cascade.**

Step text should be self-explanatory. If a step is genuinely ambiguous ("verify it looks right"), stop and ask the user what success criteria to look for — don't guess.

**Useful shortcuts:**
- Cmd+L: lock simulator
- Cmd+Shift+H: home / unlock from home screen
- Long-press: `mouse_move` → `left_mouse_down` → `wait 1.5s` → `left_mouse_up`
- Pinch zoom (rare): not supported in computer-use; use `xcrun simctl ui` if needed

**Always locate UI elements by description, then take a fresh screenshot.** Don't hardcode coordinates — simulator window position varies with zoom level and screen size. Each click should be informed by the most recent screenshot.

**Screenshots:**
- Take one after EVERY verification step — they become the audit trail
- Use the `zoom` tool to inspect small UI elements (Dynamic Island, status bar, badge counts) before claiming success/failure
- Save screenshots only when the user explicitly asks; otherwise, in-line review is enough

## Step 5 — report results

At the end, emit a per-step report:

```
=== /qa live-activities — results ===
✅ Step 1: Open menu → DEBUG → Start Live Activity (alert appeared)
✅ Step 2: Cmd+L → lock screen shows "Training your AI model" / "Ary"
✅ Step 3: Cmd+Shift+H → unlock and home
✅ Step 4: Dynamic Island compact — sparkle icon visible (left)
❌ Step 5: Tap Update → "18m left" appears in DI compact trailing
   - Screenshot showed empty trailing region. Phase may have stayed
     at .starting instead of transitioning to .running. Investigate
     LiveActivityService.debugUpdateRunning.
✅ Step 6: Long-press DI → expanded view shows title + subtitle
✅ Step 7: End (success) → LA dismissed cleanly

6 / 7 passed.
```

If any step fails, don't continue blindly — pause and ask the user whether to keep going (some failures cascade; others don't).

## Authoring a `## Visual smoke test` section

For each feature you ship that affects the UI, add a section like this to `docs/features/<feature>.md`:

```markdown
## Visual smoke test

For the `/qa` skill to drive on simulator. Each step is either an action
(tap, key, lock) or a verification (what to check in the screenshot).
Keep steps small and unambiguous — the skill will follow them literally.

1. Open menu → DEBUG → tap "Start Live Activity"
2. Verify: an alert appears with "✅ Live Activity started"
3. Tap OK on alert
4. Press Cmd+L (lock simulator)
5. Verify: lock screen banner shows title "Training your AI model"
6. Verify: lock screen banner shows subtitle (model name)
7. Press Cmd+Shift+H (unlock + home)
8. Verify: Dynamic Island compact leading shows sparkle icon
9. Open menu → DEBUG → tap "Update Live Activity"
10. Press Cmd+L
11. Verify: lock screen banner now shows ETA text (e.g., "18m left")
12. Press Cmd+Shift+H
13. Long-press Dynamic Island
14. Verify: expanded layout shows title + subtitle + thumbnail
15. Open menu → DEBUG → tap "End Live Activity (success)"
16. Press Cmd+L
17. Verify: lock screen has no LA banner (dismissed)
```

Rules for good smoke-test steps:
- **Actions and verifications interleaved.** The reader should be able to follow as a script.
- **Locate UI elements by description**, not coordinates. Coordinates depend on simulator size; descriptions ("the menu icon at top-right") are robust.
- **Verifications are concrete.** "Verify: title text says 'Training your AI model'" not "Verify: the LA looks right."
- **Each step does ONE thing.** "Tap A and verify B and C" should be three steps.
- **Scope to ONE feature.** Don't chain unrelated flows.

## When NOT to use this skill

- Code-only changes (refactoring, type-only, server-side) — there's nothing visible on simulator.
- Changes that need a real device (push notifications, biometrics, camera, ARKit) — use `/device` instead.
- Multi-app workflows (Mail → Safari → app) — computer-use isn't reliable across app switches; do those manually.
- Performance / motion verification — screenshots can't capture jank or frame drops.

## Notes

- **Smoke tests don't replace unit tests.** They cover what unit tests genuinely can't reach (lock screen rendering, Dynamic Island, system overlays, onboarding card animations). Anything testable headlessly should still be a Vitest/Swift Test.
- **The skill reads `docs/features/<feature>.md` only** — if you keep smoke-test steps elsewhere (a Notion page, a slash-command alias), the skill won't find them. Lift them into the feature doc.
- **First build is 2–3 min** (shared SwiftPM cache with `/simulator`). After that, 10–30s.
- **Don't shut down the simulator when done.** The user is mid-test.
