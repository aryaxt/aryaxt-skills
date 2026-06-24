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

## Step 3 — archive iOS

```bash
cd /Users/aryaxt/Desktop/Repos/$IOS_SCHEME/ios
ARCHIVE_PATH="$HOME/Library/Developer/Xcode/Archives/$IOS_SCHEME-ios-$(date +%Y%m%d-%H%M%S).xcarchive"

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

## Step 3b — archive Mac Catalyst (MANDATORY when the Mac export plist exists)

The presence of `ios/ExportOptions.macOS.plist` auto-detects a Mac Catalyst app. Detect it once:

```bash
test -f ios/ExportOptions.macOS.plist && echo "ship mac too" || echo "ios only"
```

- **`ios only`** — a genuinely iOS-only app (no Catalyst). Skip Steps 3b/4b/5b/6-Mac and proceed to Step 4.
- **`ship mac too`** — shipping Mac is **MANDATORY and all-or-nothing for the rest of this run.** Once detected, the run ships BOTH platforms or it is a FAILED run. You may NOT proceed past this point with iOS only because the Mac archive/export/upload errored, because Mac "is still processing," or because it seems like extra work. If any Mac step (3b/4b/5b) fails, treat the WHOLE run as failed: stop, surface the Mac error loudly, do NOT report iOS as a success, and do NOT delete archives (Step 5 cleanup is skipped). Apps that ship Mac must never silently degrade to iOS-only — that is exactly the bug that strands the macOS App on a stale build while iOS moves ahead.

> ⚠️ If you expected `ship mac too` but got `ios only` on a project known to ship Mac (e.g. the macOS App already has builds in App Store Connect), STOP — the plist is missing/untracked. Do not ship iOS alone; restore `ios/ExportOptions.macOS.plist` first.

The Mac archive is a SEPARATE binary (`.app` packaged as `.pkg` for upload) — App Store Connect tracks it as a distinct Build entity under the macOS platform, even though it carries the same `CFBundleVersion` you bumped in Step 2.

```bash
MAC_ARCHIVE_PATH="$HOME/Library/Developer/Xcode/Archives/$IOS_SCHEME-mac-$(date +%Y%m%d-%H%M%S).xcarchive"

xcodebuild \
  -project $IOS_SCHEME.xcodeproj \
  -scheme $IOS_SCHEME \
  -configuration Release \
  -destination "generic/platform=macOS,variant=Mac Catalyst" \
  -archivePath "$MAC_ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  archive
```

`-allowProvisioningUpdates` is **required for the Mac archive but NOT iOS.** On a fresh machine the Mac Catalyst *Development* provisioning profile doesn't exist locally — Apple Developer Portal only has the App Store profile (which `-exportArchive` uses later). The flag lets xcodebuild auto-create the missing dev profile via Apple's signing service on first run. It's a no-op once the dev profile is cached locally.

Same failure modes as iOS, plus:
- **Embedded extension platform mismatch** — if an iOS-only extension (e.g. a Live Activity widget) tries to embed in the Mac variant: `platformFilter: iOS` is missing on its `dependencies:` entry in `project.yml`. Fix the spec, re-run `xcodegen generate`, retry.
- **Mac Catalyst App Store profile missing** — `ios/ExportOptions.macOS.plist` references named profiles in Apple Developer Portal. If this is the first Mac upload and the plist still has `REPLACE_WITH_MAC_CATALYST_*` placeholders, stop and follow the "Mac Catalyst — one-time Apple Developer Portal setup" section below.

## Step 3c — upload ALL dSYMs to Crashlytics (mandatory)

**Do NOT rely on the in-archive `postBuildScript` alone.** That script runs inside the app target's build and historically only uploaded the main app's dSYM — leaving every embedded extension (`NotificationServiceExtension`, `TrainingLiveActivityWidget`) and every dynamic framework (the Facebook SDK `.framework`s) missing in Crashlytics. That's exactly how the dashboard accumulated "Missing (required)" dSYM warnings. The archive's `dSYMs/` folder is the authoritative, complete set — upload the whole folder explicitly here, every build, so a crash in ANY image symbolicates.

```bash
# Locate the Firebase upload-symbols tool from any DatingAIAssistant SPM checkout.
UPLOAD_SYMBOLS=$(find ~/Library/Developer/Xcode/DerivedData -path "*firebase-ios-sdk/Crashlytics/upload-symbols" -type f 2>/dev/null | head -1)
GSP="/Users/aryaxt/Desktop/Repos/$IOS_SCHEME/ios/$IOS_SCHEME/Resources/GoogleService-Info.plist"

# upload-symbols occasionally HANGS (observed: a segfault, then a 37-min stall that
# never returned) in headless / git-worktree archive runs — even though it runs fine
# interactively. A bare call therefore risks either stalling the whole release or
# (worse) silently not uploading while TestFlight still succeeds — the first sign is
# then a "Missing dSYM" email days later. So guard it: TIMEOUT every upload, then
# VERIFY every dSYM confirmed. `timeout(1)` isn't on stock macOS — this perl
# one-liner (a pending alarm is preserved across exec) is the portable equivalent;
# `gtimeout` from coreutils works too if it's installed.
run_with_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }

upload_dsyms() {                                   # $1 = a dSYMs folder
  local folder="$1" expected confirmed
  expected=$(find "$folder" -name "*.dSYM" -type d 2>/dev/null | wc -l | tr -d ' ')
  # 300s is ~10x a healthy upload; a hang blows past it and we bail loud.
  confirmed=$(run_with_timeout 300 "$UPLOAD_SYMBOLS" -gsp "$GSP" -p ios "$folder" 2>&1 \
                | tee /dev/stderr | grep -c "Successfully uploaded Crashlytics symbols")
  echo "dSYMs: $confirmed/$expected confirmed in $folder"
  [ "$expected" -gt 0 ] && [ "$confirmed" -ge "$expected" ]
}

DSYM_UPLOAD_OK=1
upload_dsyms "$ARCHIVE_PATH/dSYMs" || DSYM_UPLOAD_OK=0
# Mac Catalyst archive (only if Step 3b ran) carries its own dSYMs:
[ -n "${MAC_ARCHIVE_PATH:-}" ] && { upload_dsyms "$MAC_ARCHIVE_PATH/dSYMs" || DSYM_UPLOAD_OK=0; }
export DSYM_UPLOAD_OK
```

The iOS archive should yield **6** dSYMs (app, 2 app extensions, 3 Facebook frameworks); `expected` is read from the folder so the check self-adjusts if that set changes. If `UPLOAD_SYMBOLS` is empty, no archive has resolved the Firebase SPM yet — run the archive (Step 3) once, or `find` a different DerivedData path. **Run this step BEFORE the archive cleanup in Step 5**, since cleanup deletes `$ARCHIVE_PATH`.

**If `DSYM_UPLOAD_OK` ends up `0`, treat it as a blocking, unresolved item — never proceed silently.** The TestFlight upload is independent of this, so the build still ships; but: (a) do NOT delete the archive in the Step-5 cleanup — it holds the only copy of the dSYMs (see the gate there), and (b) surface a loud warning to the user at the very end of the run, e.g.:

> ⚠️ dSYMs were NOT uploaded to Crashlytics for build `$NEW_BUILD` (upload timed out or didn't confirm). Crashes in this build won't symbolicate until you re-run the recovery below. The archive has been kept at `$ARCHIVE_PATH`.

> **Recovering a build's missing dSYMs (current or old):** App Store Connect has **no** downloadable dSYM — the app ships without bitcode, so Apple keeps no copy, and `GET /v1/builds/{id}/buildBundles` 403s under this ASC key's role. The local dSYMs are the only copy, and they usually survive even after the `.xcarchive` is deleted: Xcode leaves them in DerivedData at `…/DerivedData/<proj-hash>/Build/Intermediates.noindex/ArchiveIntermediates/$IOS_SCHEME/BuildProductsPath/Release-iphoneos/*.dSYM`. Find the one Crashlytics is asking for by UUID and re-upload — the binary runs fine standalone (the hang is environmental to the headless archive, not a permanent fault):
> ```bash
> TARGET=<UUID from the Firebase "Missing dSYM" email>
> DSYM=$(find ~/Library/Developer/Xcode/DerivedData ~/Library/Developer/Xcode/Archives -name "*.dSYM" -type d 2>/dev/null \
>          | while read -r d; do dwarfdump --uuid "$d" 2>/dev/null | grep -qi "$TARGET" && echo "$d"; done | head -1)
> "$UPLOAD_SYMBOLS" -gsp "$GSP" -p ios "$DSYM"   # then upload the sibling extension/framework dSYMs in the same folder too
> ```
> Only truly unrecoverable if DerivedData was also cleared since the build (a rebuild from the `ios-build-<N>` tag only reproduces a matching UUID if the toolchain is byte-identical — unreliable).

## Step 4 — export iOS IPA

```bash
EXPORT_DIR="$HOME/Library/Developer/Xcode/Archives/export-ios-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EXPORT_DIR"

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath "$EXPORT_DIR"
```

The IPA lands at `$EXPORT_DIR/$IOS_SCHEME.ipa`.

## Step 4b — export Mac Catalyst .pkg (MANDATORY when shipping Mac)

```bash
MAC_EXPORT_DIR="$HOME/Library/Developer/Xcode/Archives/export-mac-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$MAC_EXPORT_DIR"

xcodebuild \
  -exportArchive \
  -archivePath "$MAC_ARCHIVE_PATH" \
  -exportOptionsPlist ExportOptions.macOS.plist \
  -exportPath "$MAC_EXPORT_DIR"
```

The Mac binary lands at `$MAC_EXPORT_DIR/$IOS_SCHEME.pkg` (App Store distribution wraps the .app in a .pkg installer).

## Step 5 — upload iOS to TestFlight

```bash
xcrun altool --upload-app \
  --type ios \
  --file "$EXPORT_DIR/$IOS_SCHEME.ipa" \
  --apiKey HUGD2M7X2Y \
  --apiIssuer "<ISSUER_UUID>"
```

`altool` validates and uploads in one shot, ~3–5 minutes. Success returns `No errors uploading...` and an upload UUID. The build then takes another 10–30 minutes server-side to finish processing before it appears in TestFlight (and another wait if export compliance is needed).

## Step 5b — upload Mac Catalyst to TestFlight (MANDATORY when shipping Mac)

```bash
xcrun altool --upload-app \
  --type macos \
  --file "$MAC_EXPORT_DIR/$IOS_SCHEME.pkg" \
  --apiKey HUGD2M7X2Y \
  --apiIssuer "<ISSUER_UUID>"
```

Same Apple-side processing wait (~10–30 min). The Mac build appears under "macOS App" in App Store Connect, separate from the iOS App entry.

If you see:
- **`Authentication credentials are missing or invalid`** → wrong issuer ID, or `.p8` file moved
- **`The bundle version must be higher than the previously uploaded version`** → step 2 was skipped or the bump didn't reach Info.plist
- **`Invalid Code Signing Entitlements`** → ExportOptions teamID wrong, or the entitlements file diverged

### Clean up the archive and export after a successful upload

`.xcarchive` bundles are 200–500 MB each and `~/Library/Developer/Xcode/Archives/` accumulates them silently — at one bump per day, that's >10 GB/month of dead disk. Once `altool` returned success the export dir is no longer needed: TestFlight has the IPA/PKG and the GitHub tag in Step 7 records the source SHA. The **archive** is only safe to drop once Step 3c also confirmed the dSYM upload (`DSYM_UPLOAD_OK=1`) — otherwise it holds the only copy of the dSYMs (App Store Connect has none), so keep it for the recovery in Step 3c.

```bash
# The export dir is always safe to drop — the IPA/PKG is on TestFlight now.
rm -rf -- "${EXPORT_DIR:?EXPORT_DIR must be set}"
[ -n "${MAC_EXPORT_DIR:-}" ] && rm -rf -- "${MAC_EXPORT_DIR:?}"

# Drop the archive(s) ONLY if Step 3c confirmed the dSYM upload; else keep them.
if [ "${DSYM_UPLOAD_OK:-1}" = 1 ]; then
  rm -rf -- "${ARCHIVE_PATH:?ARCHIVE_PATH must be set}"
  [ -n "${MAC_ARCHIVE_PATH:-}" ] && rm -rf -- "${MAC_ARCHIVE_PATH:?}"
else
  echo "⚠️ Keeping $ARCHIVE_PATH — dSYM upload was not confirmed (see Step 3c recovery)."
fi
```

The `${VAR:?...}` form aborts (instead of degrading to `rm -rf ""`) if a variable was never assigned in this shell session, and the `--` end-of-options sentinel keeps a path that begins with `-` from being parsed as a flag. Only run this after `altool` printed `No errors uploading…`. If the upload failed, keep everything — re-exporting from a fresh archive takes 5–10 minutes.

## Step 6 — assign build to test groups, submit for beta review, notify testers

After the upload, run the assigner — it polls App Store Connect until the build reaches `VALID`, POSTs the build to every external beta group on the app, **then submits the build for beta app review**.

```bash
node scripts/asc-assign-build.mjs "$NEW_BUILD" --platform=IOS

# If you shipped Mac Catalyst in Steps 3b/4b/5b too:
test -f ios/ExportOptions.macOS.plist && node scripts/asc-assign-build.mjs "$NEW_BUILD" --platform=MAC_OS
```

Run the iOS invocation first, then the Mac invocation. They poll independently — iOS typically reaches `VALID` ~10 min before Mac, so back-to-back execution is fine (the Mac poll may sit at `PROCESSING` for a while, that's normal).

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
  --prerelease \
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
- **Every TestFlight upload is created as a `--prerelease`.** GitHub's "Latest release" badge stays on the most recent App Store-shipped build (see below). When Apple accepts a build for the App Store, promote it manually:
  ```bash
  gh release edit ios-build-<NUM> --prerelease=false --latest \
    --title "App Store <MARKETING> (Build <NUM>)"
  ```
  This keeps a single source-of-truth release per build — no duplicate tags — and the "Latest" pointer in the Releases tab always reflects what's actually shipping to end users.
- The commit filter strips chore/ci/docs noise — testers see only feature and fix bullets.
- `fix:` commits get a 🐛 prefix and `perf:` get ⚡ so the list is scannable at a glance.
- The metadata table gives you version, build, commit SHA, and a direct App Store Connect link in one place.
- If the project later pushes backend builds with their own tags, `--match 'ios-build-*'` in `PREV_TAG` keeps the range scoped to iOS-only commits.
- First-ever build: `PREV_TAG` will be empty, `RANGE` collapses to just `$TAG`, and git log lists all commits — fine for a bootstrap release.
- If `gh` isn't authenticated: `gh auth status`; user runs `gh auth login` themselves.

## Step 8 — report to the user

After the upload command returns success:
1. Tell the user the build number that shipped (e.g. "Build 20260426 uploaded")
2. **If Step 3b detected `ship mac too`, you MUST have uploaded BOTH legs — report them together: "iOS + Mac Catalyst builds 20260426 uploaded."** Never report this run as successful with only the iOS leg uploaded when Mac was applicable; an iOS-only result on a Catalyst app is a FAILED run, not a partial success. If the Mac leg did not upload, say so loudly and treat the run as incomplete.
3. Note that App Store Connect needs ~10–30 min to process before testers see it (Mac usually trails iOS by 5–10 min)
4. Confirm that the build was assigned to "main" (internal) and "External testers" groups and that testers will be notified automatically
5. Link to [appstoreconnect.apple.com/apps](https://appstoreconnect.apple.com/apps) so they can watch processing

## Mac Catalyst — one-time per-Mac setup

Apps that ship to both iOS and macOS TestFlight need two things that iOS-only apps don't:
1. A **Mac Installer Distribution** certificate (for signing the `.pkg` installer)
2. **Mac Catalyst App Store** provisioning profiles for every bundle id (one per signed binary)

The `scripts/setup-mac-signing.mjs` script automates both via the App Store Connect API. Run it once per Mac that needs to ship Mac Catalyst builds:

```bash
# Step A: enable Mac Catalyst on each App ID in the browser (one-time, per app):
#   developer.apple.com/account/resources/identifiers → open each bundle id
#   listed in ios/ExportOptions.macOS.plist → tick "Mac Catalyst" → Save.
#   Pick "Use existing Mac App ID" if prompted.
#
# Step B: run the setup script. Creates the Mac Installer Distribution cert
# (if missing), imports it into the login keychain, then creates + downloads
# the Mac Catalyst App Store profiles for every bundle id in `wanted`.
node scripts/setup-mac-signing.mjs
```

The script is idempotent. Re-running on a Mac that already has the cert + profiles is a no-op (it just re-downloads the .mobileprovision files into `~/Library/MobileDevice/Provisioning Profiles/`, which is harmless).

The script uses the same `APPLE_ASC_*` credentials from `.env.local` that `asc-assign-build.mjs` does.

After the script runs once, `/testflight` can ship to both platforms without further setup. If you add a new App ID to the project (e.g. a new extension), edit the `wanted` array at the top of `scripts/setup-mac-signing.mjs` to include it, then re-run.

## Things to watch for

- **Mac Catalyst is all-or-nothing, never a silent skip.** If `ios/ExportOptions.macOS.plist` exists (Step 3b detects `ship mac too`), the run ships BOTH iOS and Mac or it FAILS — there is no valid "iOS shipped, Mac skipped/failed, call it done" outcome. A Mac archive/export/upload error blocks the whole run: surface it loudly, keep the archives, and do not claim success. This is the exact failure that leaves the macOS App stuck on a stale build (e.g. the 1 AM `20260623` build) while iOS advances to `20260623.1` — the user has explicitly required both every time for this app.
- **Never push to main from a feature branch as part of this flow.** The build-number commit is allowed because it's a chore commit on main, but per `CLAUDE.md` the user requires PR review for everything else. If there are unpushed feature commits, surface them and ask.
- **dSYM upload to Crashlytics** happens twice: a best-effort `postBuildScript` inside the archive (uploads the whole `${DWARF_DSYM_FOLDER_PATH}`) AND the authoritative **Step 3c** that uploads the entire `$ARCHIVE_PATH/dSYMs/` folder. Step 3c is the one that guarantees coverage — never skip it, and never let it fail silently: it now caps each upload with a timeout and verifies every dSYM confirmed (`DSYM_UPLOAD_OK`), the Step-5 cleanup keeps the archive when that flag is `0`, and an unconfirmed upload must be surfaced loudly at the end of the run (this is exactly how build 20260620 shipped without dSYMs and triggered a "Missing dSYM" email — the upload hung and the gap was buried). If Crashlytics still shows "missing dSYMs" after a run, use the **Recovering a build's missing dSYMs** recovery in Step 3c (find the dSYM by UUID in DerivedData / the archive, then re-`upload-symbols` it).
- **Don't `xcodebuild clean` before archiving** — it forces a full SwiftPM re-resolution that can take 10+ extra minutes for the Firebase SDK chain. Only clean if you're debugging a stale-build issue.
- **Build-number monotonicity is per `CFBundleShortVersionString` AND per platform.** Within iOS, all builds for marketing version "1.0" must be strictly increasing. Within macOS, same rule independently. iOS and Mac builds with the same `CFBundleVersion` are fine — they live under separate Build entities in App Store Connect.
- **Mac builds take longer to process** than iOS — Apple's macOS notarization step adds 5–15 min on top of the standard processing. Don't panic if Step 6's Mac poll sits at `PROCESSING` after the iOS one reached `VALID`.
