---
name: testflight
description: Use when the user asks to "ship to TestFlight", "push to TestFlight", "release a build to testers", or otherwise deploy the iOS app from local main to App Store Connect. Walks through pulling main, bumping the build number, archiving, exporting, and uploading via the App Store Connect API key.
---

# Deploy iOS App to TestFlight

This project has **no fastlane and no CI workflow** for iOS — TestFlight uploads are done manually from a local machine via `xcodebuild` + `xcrun altool`. This skill is the canonical procedure.

## Prerequisites (verify first, don't assume)

1. **Working tree clean** on `main` and synced with `origin/main`. Local changes to `.claude/settings.local.json` and `*.xcuserstate` are fine — they're gitignored noise.
2. **App Store Connect API key** at `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`. The current key is `AuthKey_HUGD2M7X2Y.p8` → key ID `HUGD2M7X2Y`.
3. **Issuer ID** — read from `.env.local` as `APPLE_ASC_ISSUER_ID` (also used by `src/lib/services/asc-api.ts` for the admin IAP catalog reads). Same key/issuer pair powers altool uploads. If `.env.local` is missing, fall back to [appstoreconnect.apple.com/access/integrations/api](https://appstoreconnect.apple.com/access/integrations/api).
4. **Xcode + xcodebuild** installed and signed into the team `$IOS_TEAM_ID` (automatic signing in `ios/ExportOptions.plist`).
5. **XcodeGen** (`brew install xcodegen`) — the project is generated from `ios/project.yml`. **Source of truth for build number is `project.yml`, NOT the generated `project.pbxproj`.**

If any prereq is missing, stop and ask before continuing — this is a user-visible action (testers receive the build).

## Step 1 — sync main (mandatory, no shortcuts)

TestFlight builds MUST come from latest `main`. Never archive from a feature branch or stale main — testers will get code that doesn't match the source of truth.

```bash
cd /Users/aryaxt/Desktop/Repos/$IOS_SCHEME
git fetch origin
git checkout main
git pull --ff-only origin main
```

Verification gates — abort and ask the user if any fails:
- `git rev-parse --abbrev-ref HEAD` → must be `main`
- `git status --porcelain` → ignore `.claude/settings.local.json` and `*.xcuserstate`; abort on any other modified/untracked file
- `git log origin/main..HEAD --oneline` → must be empty (no unpushed commits — if any exist, ask whether to push or stash)
- `git log HEAD..origin/main --oneline` → must be empty after the pull (you're truly up to date)

Capture `LAST_RELEASE_TAG=$(git describe --tags --match 'ios-build-*' --abbrev=0 2>/dev/null || echo "")` — used for changelog generation in Step 7.

## Step 2 — bump build number

**Don't trust `project.yml` / `Info.plist` as the source of truth for "what's already on TestFlight."** Past bump commits may have been reverted, never committed, or shipped without commit. Always query App Store Connect directly:

```bash
# Reuses APPLE_ASC_KEY_ID / APPLE_ASC_ISSUER_ID / APPLE_ASC_PRIVATE_KEY / APPLE_APP_ID from .env.local
node scripts/asc-latest-build.mjs
```

The script prints the 5 most recent builds with their version numbers. Ignore `processingState: "INVALID"` (rejected) but still treat them as "used" — Apple won't accept the same string twice even after rejection.

**Versioning scheme — date-based `YYYYMMDD`:**
- This project uses `CFBundleVersion = YYYYMMDD` (e.g. `20260419` for a build cut on 2026-04-19).
- For a *second* build on the same day, append `.N` → `20260419.1`, `20260419.2`, etc. Apple allows 1–4 dot-separated integer components in `CFBundleVersion`.
- Pick: `today YYYYMMDD` if no prior build today, otherwise `<today>.<next-suffix>`.

Then edit `ios/project.yml`:

```yaml
settings:
  base:
    CURRENT_PROJECT_VERSION: "1"      # bump this
info:
  properties:
    CFBundleVersion: "1"              # bump this too — must match
    CFBundleShortVersionString: "1.0" # marketing version — only bump on user-visible release
```

Use the `Edit` tool to increment `CURRENT_PROJECT_VERSION` and `CFBundleVersion` to the same new value (e.g. `"2"`). Do NOT bump `MARKETING_VERSION` / `CFBundleShortVersionString` unless the user explicitly asks for a new public version.

**Why both fields:** `project.yml` writes `CURRENT_PROJECT_VERSION` into build settings, but `Info.plist` is a separate file with its own `CFBundleVersion` literal. If they drift, App Store Connect rejects the upload with "CFBundleVersion mismatch".

Then regenerate the Xcode project:

```bash
cd ios && xcodegen generate
```

Commit the bump on `main` and push to `origin` BEFORE archiving — this guarantees the shipped binary corresponds to a real commit on `origin/main` that you can tag in Step 7:

```bash
git add ios/project.yml ios/$IOS_SCHEME.xcodeproj/project.pbxproj ios/$IOS_SCHEME/Resources/Info.plist
git commit -m "chore(ios): bump build to <N> for TestFlight"
git push origin main
```

Capture the resulting commit SHA — `RELEASE_SHA=$(git rev-parse HEAD)` — you'll attach it to the GitHub release.

## Step 3 — archive

```bash
cd /Users/aryaxt/Desktop/Repos/$IOS_SCHEME/ios
ARCHIVE_PATH="$HOME/Library/Developer/Xcode/Archives/$IOS_SCHEME-$(date +%Y%m%d-%H%M%S).xcarchive"

xcodebuild \
  -project $IOS_SCHEME.xcodeproj \
  -scheme $IOS_SCHEME \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  archive
```

Run with `run_in_background: true` and monitor — archives take 5–10 minutes. If it fails, the failure is almost always one of:
- **Code signing**: missing provisioning profile → user opens Xcode once to refresh, then retry
- **Swift package resolution timeout**: rerun, or `rm -rf ~/Library/Developer/Xcode/DerivedData/$IOS_SCHEME-*` and retry
- **Crashlytics dSYM upload script** failing on missing `GoogleService-Info.plist` — should not happen on `main`

## Step 4 — export IPA

```bash
EXPORT_DIR="$HOME/Library/Developer/Xcode/Archives/export-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EXPORT_DIR"

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath "$EXPORT_DIR"
```

The IPA lands at `$EXPORT_DIR/$IOS_SCHEME.ipa`.

## Step 5 — upload to TestFlight

```bash
xcrun altool --upload-app \
  --type ios \
  --file "$EXPORT_DIR/$IOS_SCHEME.ipa" \
  --apiKey HUGD2M7X2Y \
  --apiIssuer "<ISSUER_UUID>"
```

`altool` validates and uploads in one shot, ~3–5 minutes. Success returns `No errors uploading...` and an upload UUID. The build then takes another 10–30 minutes server-side to finish processing before it appears in TestFlight (and another wait if export compliance is needed).

If you see:
- **`Authentication credentials are missing or invalid`** → wrong issuer ID, or `.p8` file moved
- **`The bundle version must be higher than the previously uploaded version`** → step 2 was skipped or the bump didn't reach Info.plist
- **`Invalid Code Signing Entitlements`** → ExportOptions teamID wrong, or the entitlements file diverged

### Clean up the archive and export after a successful upload

`.xcarchive` bundles are 200–500 MB each and `~/Library/Developer/Xcode/Archives/` accumulates them silently — at one bump per day, that's >10 GB/month of dead disk. Once `altool` returned success the archive and export dir are no longer needed: TestFlight has the IPA, dSYMs are already in Crashlytics (Step 3 postBuildScript), and the GitHub tag in Step 7 records the source SHA.

```bash
rm -rf -- "${ARCHIVE_PATH:?ARCHIVE_PATH must be set}" "${EXPORT_DIR:?EXPORT_DIR must be set}"
```

The `${VAR:?...}` form aborts (instead of degrading to `rm -rf ""`) if either variable was never assigned in this shell session, and the `--` end-of-options sentinel keeps a path that begins with `-` from being parsed as a flag. Only run this after `altool` printed `No errors uploading…`. If the upload failed, keep the archive — re-exporting from a fresh archive takes 5–10 minutes.

## Step 6 — assign build to test groups, submit for beta review, notify testers

After the upload, run the assigner — it polls App Store Connect until the build reaches `VALID`, POSTs the build to every external beta group on the app, **then submits the build for beta app review**.

```bash
node scripts/asc-assign-build.mjs "$NEW_BUILD"
```

**Why the submit step matters (and why the API is not the UI):** assigning a build to an external group is *not* the same as submitting it for review. Without an explicit `POST /v1/betaAppReviewSubmissions`, the build sits at "Ready to Submit" with the yellow clock icon forever — external testers never see it. The App Store Connect *website* auto-creates the submission when you add a build to a group through the UI, which is why the manual workaround "delete the build and re-add it through ASC" used to work; the API has no such auto-step. The script now does both.

The script reuses the same `jose`-based JWT plumbing as `scripts/asc-latest-build.mjs`. **Don't try to hand-roll the JWT in bash** — `openssl dgst -sha256 -sign` produces DER-encoded signatures, but ES256 JWTs require raw `R||S` concatenation (64 bytes); Apple returns 401 on every request to a DER-signed JWT.

**Internal vs external groups:** the script assigns the build to all *external* groups on the app. **Internal groups (e.g. "main" in this project) are skipped on purpose** — Apple's API rejects internal-group assignment with HTTP 422 (`Cannot add internal group to a build`). Internal testers automatically receive new builds once processing completes; no explicit assignment is required (or possible).

**Notes:**
- The script is **idempotent** — re-running it on a build that's already assigned and/or already submitted is safe. Duplicate group assignment is a no-op; a duplicate `betaAppReviewSubmission` returns HTTP 409 which the script treats as already-submitted.
- Polling defaults to 60s × 30 attempts (~30 min). If Apple is unusually slow, edit the constants at the top of the script.
- Apple notifies testers automatically once the build passes beta review (usually within a few hours, occasionally up to 24h for the first build of a new marketing version).
- If a build is stuck at "Ready to Submit" from a previous broken run, just re-run `node scripts/asc-assign-build.mjs <version>` — the script will re-submit it.

## Step 7 — tag and create a GitHub release

After altool returns success, create an annotated git tag and a rich GitHub release. The release body is hand-crafted (not just `--generate-notes`) so it contains a clean bullet list of changes, key metadata, and a TestFlight deep link.

```bash
NEW_BUILD="<the-version-you-bumped-to>"   # e.g. "20260426.1"
MARKETING_VERSION="1.0"                   # read from project.yml CFBundleShortVersionString
TAG="ios-build-${NEW_BUILD}"

# Tag the commit that was archived
git tag -a "$TAG" "$RELEASE_SHA" -m "iOS TestFlight build ${NEW_BUILD}"
git push origin "$TAG"

# Find the previous ios-build-* tag (for commit range)
PREV_TAG=$(git describe --tags --match 'ios-build-*' --abbrev=0 "${TAG}^" 2>/dev/null || echo "")
RANGE="${PREV_TAG:+${PREV_TAG}..}${TAG}"

# Build a bullet list of user-facing changes from commit subjects since last build.
# - Skip chore/build/ci/docs/test commits (they're noise for testers).
# - Prefer PR titles (merge commits) over raw commit subjects when available.
CHANGES=$(git log "$RANGE" --pretty=format:"%s" \
  | grep -Ev '^(chore|build|ci|docs|test|Merge pull request|Merge branch)' \
  | sed 's/^feat[(:].*): //' \
  | sed 's/^fix[(:].*): /🐛 /' \
  | sed 's/^perf[(:].*): /⚡ /' \
  | sed 's/^/- /' \
  | head -30)

# Fallback if everything was filtered out
[ -z "$CHANGES" ] && CHANGES="- Internal improvements and bug fixes"

BUILD_DATE=$(date -u "+%Y-%m-%d %H:%M UTC")
COMMIT_SHORT=$(echo "$RELEASE_SHA" | cut -c1-8)

gh release create "$TAG" \
  --target "$RELEASE_SHA" \
  --title "iOS ${MARKETING_VERSION} (Build ${NEW_BUILD})" \
  --notes "$(cat <<NOTES
## What's new

${CHANGES}

---

| Field | Value |
|---|---|
| **Marketing version** | ${MARKETING_VERSION} |
| **Build number** | ${NEW_BUILD} |
| **Commit** | [\`${COMMIT_SHORT}\`](../../commit/${RELEASE_SHA}) |
| **Built** | ${BUILD_DATE} |
| **TestFlight** | [Open in App Store Connect](https://appstoreconnect.apple.com/apps) |

> Distributed to **main** (internal) and **External testers** groups via TestFlight.
NOTES
)"
```

Notes:
- The commit filter strips chore/ci/docs noise — testers see only feature and fix bullets.
- `fix:` commits get a 🐛 prefix and `perf:` get ⚡ so the list is scannable at a glance.
- The metadata table gives you version, build, commit SHA, and a direct App Store Connect link in one place.
- If the project later pushes backend builds with their own tags, `--match 'ios-build-*'` in `PREV_TAG` keeps the range scoped to iOS-only commits.
- First-ever build: `PREV_TAG` will be empty, `RANGE` collapses to just `$TAG`, and git log lists all commits — fine for a bootstrap release.
- If `gh` isn't authenticated: `gh auth status`; user runs `gh auth login` themselves.

## Step 8 — report to the user

After the upload command returns success:
1. Tell the user the build number that shipped (e.g. "Build 20260426 uploaded")
2. Note that App Store Connect needs ~10–30 min to process before testers see it
3. Confirm that the build was assigned to "main" (internal) and "External testers" groups and that testers will be notified automatically
4. Link to [appstoreconnect.apple.com/apps](https://appstoreconnect.apple.com/apps) so they can watch processing

## Things to watch for

- **Never push to main from a feature branch as part of this flow.** The build-number commit is allowed because it's a chore commit on main, but per `CLAUDE.md` the user requires PR review for everything else. If there are unpushed feature commits, surface them and ask.
- **dSYM upload to Crashlytics** runs as a postBuildScript inside the archive — verify in the build log it succeeded (look for "Successfully uploaded Crashlytics dSYMs"). If it fails, Crashlytics will show "missing dSYMs" in the dashboard and you can manually upload from the `.xcarchive/dSYMs/` directory later.
- **Don't `xcodebuild clean` before archiving** — it forces a full SwiftPM re-resolution that can take 10+ extra minutes for the Firebase SDK chain. Only clean if you're debugging a stale-build issue.
- **Build-number monotonicity is per `CFBundleShortVersionString`**: e.g. for marketing version "1.0" all builds must be strictly increasing integers. If you bump to "1.1", the build counter resets is allowed but most teams keep it monotonic forever to avoid confusion.
