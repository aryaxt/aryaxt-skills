---
name: playstore
description: Use when the user asks to "ship to Play Store", "push to Google Play", "release an Android build to testers", "upload to the Play internal track", or otherwise deploy the Android app from local main to Google Play. Walks through pulling main, bumping the versionCode, building a signed AAB, and uploading via the Google Play Developer API. The Android counterpart of /testflight.
---

# Deploy Android App to Google Play

This project has **no fastlane and no CI workflow** for Android — Play uploads are done manually from a local machine via Gradle (`bundleRelease`) + a small Node uploader that talks to the Google Play Developer Publishing API. This skill is the canonical procedure, and is the Android mirror of `/testflight`.

**The uploader scripts ship WITH this skill** (`play-latest-build.mjs`, `play-upload-aab.mjs`, `play-lib.mjs` in the skill's own directory) and are **generic / app-agnostic** — they take the package id and service-account path from flags or environment, so the same scripts work for every consuming app. Set `SKILL_DIR` to this skill's base directory (printed when the skill is invoked) and call the scripts from there:

```bash
SKILL_DIR="<this skill's base directory>"   # e.g. ~/.claude/plugins/.../skills/playstore
```

Per-project values come from `scripts/android-config.sh` in the consuming repo (`ANDROID_APPLICATION_ID`, `ANDROID_KEYSTORE_PATH`, `ANDROID_PLAY_SERVICE_ACCOUNT_JSON`, `ANDROID_PLAY_DEFAULT_TRACK`, …). Source it first — the scripts read `ANDROID_APPLICATION_ID` / `ANDROID_PLAY_SERVICE_ACCOUNT_JSON` from the environment it exports.

> **Greenfield note:** the Android app is being built feature-by-feature (see `docs/superpowers/specs/2026-06-01-android-port-foundation-design.md`). This skill is usable once the `android/` Gradle project exists, an upload keystore has been created, the app is registered in the Play Console, and a Play service account JSON is in place (see "One-time Play setup" at the bottom). If any of those are missing, do that setup first — don't try to ship a project that can't be signed or has no Play listing.

## Prerequisites (verify first, don't assume)

1. **Working tree clean** on `main` and synced with `origin/main`. Local-only noise (`.claude/settings.local.json`, `*.iml`, `.gradle/`) is fine.
2. **`android/` project exists** — `test -d android || stop`.
3. **Upload keystore** at `$ANDROID_KEYSTORE_PATH` (default `~/.android-signing/canvaspell-upload.keystore`), with the alias `$ANDROID_KEY_ALIAS`. The keystore passwords live in `~/.android-signing/keystore.properties` (or env), **never committed**.
4. **Play service account JSON** at `$ANDROID_PLAY_SERVICE_ACCOUNT_JSON` — a Google Cloud service account granted release access in the Play Console (Users & permissions → Invite → grant "Release to testing tracks"). Used by the uploader to authenticate to the Publishing API.
5. **`googleapis` available** to the Node uploader — installed in the consuming project (`npm ls googleapis`; if missing, `npm i -D googleapis`). The scripts resolve it from the project's `node_modules` even though they live in the skill dir. The uploader is `$SKILL_DIR/play-upload-aab.mjs`.
6. **Java + Android SDK** installed and on PATH (`./gradlew` works; `adb`/`sdkmanager` resolve).

If any prereq is missing, stop and ask before continuing — this is a user-visible action (testers receive the build).

## Step 1 — sync main (mandatory, no shortcuts)

Play builds MUST come from latest `main`. Never build from a feature branch or stale main — testers would get code that doesn't match the source of truth.

```bash
cd /Users/aryaxt/Desktop/Repos/$ANDROID_SCHEME
git fetch origin
git checkout main
git pull --ff-only origin main
```

Verification gates — abort and ask the user if any fails:
- `git rev-parse --abbrev-ref HEAD` → must be `main`
- `git status --porcelain` → ignore `.claude/settings.local.json` and local Android noise; abort on any other modified/untracked file
- `git log origin/main..HEAD --oneline` → must be empty (no unpushed commits)
- `git log HEAD..origin/main --oneline` → must be empty after the pull

Capture `LAST_RELEASE_TAG=$(git describe --tags --match 'android-build-*' --abbrev=0 2>/dev/null || echo "")` — used for changelog generation in Step 6.

## Step 2 — bump versionCode

**Don't trust `build.gradle.kts` as the source of truth for "what's already on Play."** Always query the Play track directly so a reverted/uncommitted bump can't cause a collision (the Publishing API rejects a duplicate or non-increasing `versionCode`):

```bash
source scripts/android-config.sh
# Reuses ANDROID_PLAY_SERVICE_ACCOUNT_JSON / ANDROID_APPLICATION_ID from the env
# android-config.sh exports. Prints the highest versionCode reserved across all
# tracks' releases AND every uploaded bundle (a versionCode is "used" at upload
# time, even if never assigned to a track).
node "$SKILL_DIR/play-latest-build.mjs"
```

**Versioning scheme — date-based, mirroring iOS:**
- `versionName` mirrors the iOS `CFBundleShortVersionString` (e.g. `1.0`) — only bump on a user-visible release.
- `versionCode` is a strictly-increasing integer using `YYYYMMDD` × 10 + same-day-counter:
  - first build on 2026-06-01 → `202606010`
  - second build same day → `202606011`, etc.
  - This stays monotonic across days and well under Play's `versionCode` ceiling (2,100,000,000).
- Pick: `${YYYYMMDD}0` if no build today, else `${YYYYMMDD}<next-counter>`.

Then edit `android/app/build.gradle.kts`:

```kotlin
defaultConfig {
    versionCode = 202606010   // bump this
    versionName = "1.0"        // marketing — only bump on user-visible release
}
```

Use the `Edit` tool to set `versionCode` to the new value. Do NOT bump `versionName` unless the user explicitly asks for a new public version.

Commit the bump on `main` and push to `origin` BEFORE building — this guarantees the shipped AAB corresponds to a real commit on `origin/main` that you can tag in Step 6:

```bash
git add android/app/build.gradle.kts
git commit -m "chore(android): bump versionCode to <N> for Play internal track"
git push origin main
```

Capture the resulting commit SHA — `RELEASE_SHA=$(git rev-parse HEAD)` — you'll attach it to the GitHub release.

## Step 3 — build a signed release AAB

Android App Bundles (`.aab`) are the required upload format for Play (Play generates per-device APKs from it).

```bash
source scripts/android-config.sh
cd android
# Signing config in app/build.gradle.kts reads the keystore path / alias / passwords
# from ~/.android-signing/keystore.properties (or env). NEVER inline secrets here.
./gradlew :"$ANDROID_MODULE":bundleRelease 2>&1 | tail -30
cd -
AAB="android/app/build/outputs/bundle/release/app-release.aab"
test -f "$AAB" || { echo "bundleRelease succeeded but AAB not found at $AAB"; exit 1; }
```

Run with `run_in_background: true` and monitor — a clean release build is 2–5 minutes. **Never pipe in a way that hides `BUILD FAILED`** — check the exit status. Common failures:
- **Signing**: keystore not found / wrong passwords → verify `$ANDROID_KEYSTORE_PATH` and `keystore.properties`.
- **Missing `google-services.json`** for the release variant → Firebase Android app not wired.
- **Minify/R8 stripping** something reflective → add the missing `-keep` rule; don't disable minification to paper over it.

## Step 4 — upload to the Play track

```bash
source scripts/android-config.sh
# Authenticates with the service-account JSON, uploads the AAB to the track,
# sets the release notes, and (for testing tracks) rolls out to 100%.
# Add --mapping=android/app/build/outputs/mapping/release/mapping.txt when minify is on.
node "$SKILL_DIR/play-upload-aab.mjs" "$AAB" --track="${ANDROID_PLAY_DEFAULT_TRACK}" --versionCode=<N>
```

The default track is `internal` (fastest propagation, mirrors TestFlight internal testers). Use `--track=alpha` / `--track=beta` for wider testing groups. Production rollout is intentionally NOT the default — never push to `production` without the user explicitly asking.

Success returns the committed edit id and the track the build landed on. Play processes the bundle server-side (usually a few minutes for internal; longer for review-gated tracks).

If you see:
- **`APK specifies a version code that has already been used`** → Step 2 was skipped or the bump didn't reach `build.gradle.kts`.
- **`The caller does not have permission`** → the service account lacks release access in the Play Console, or the JSON is for the wrong project.
- **`Package not found`** → `ANDROID_APPLICATION_ID` doesn't match a registered app in the Play Console (the first-ever upload must be done manually through the Play Console UI before the API will accept uploads).

## Step 5 — clean up the build output

The `.aab` and intermediate build artifacts can be large. After a successful upload they're no longer needed — Play has the bundle, and the GitHub tag in Step 6 records the source SHA.

```bash
rm -f -- "${AAB:?AAB must be set}"
# Optionally clear the release build dir to reclaim space:
# rm -rf android/app/build/outputs/bundle/release
```

Only run after the uploader printed success. If the upload failed, keep the AAB — re-building takes minutes.

## Step 6 — tag and create a GitHub release

After the upload returns success, create an annotated git tag and a rich GitHub release — the Android counterpart of `/testflight`'s `ios-build-*` tags. Use the `android-build-*` prefix so the two platforms' tag ranges stay independent.

```bash
NEW_BUILD="<the-versionCode-you-bumped-to>"   # e.g. "202606010"
VERSION_NAME="1.0"                            # read from build.gradle.kts versionName
TAG="android-build-${NEW_BUILD}"

git tag -a "$TAG" "$RELEASE_SHA" -m "Android Play build ${NEW_BUILD}"
git push origin "$TAG"

# Previous android-build-* tag for the commit range
PREV_TAG=$(git describe --tags --match 'android-build-*' --abbrev=0 "${TAG}^" 2>/dev/null || echo "")
RANGE="${PREV_TAG:+${PREV_TAG}..}${TAG}"

# Bullet list of user-facing changes (skip chore/build/ci/docs/test noise)
CHANGES=$(git log "$RANGE" --pretty=format:"%s" \
  | grep -Ev '^(chore|build|ci|docs|test|Merge pull request|Merge branch)' \
  | sed 's/^feat[(:].*): //' \
  | sed 's/^fix[(:].*): /🐛 /' \
  | sed 's/^perf[(:].*): /⚡ /' \
  | sed 's/^/- /' \
  | head -30)
[ -z "$CHANGES" ] && CHANGES="- Internal improvements and bug fixes"

BUILD_DATE=$(date -u "+%Y-%m-%d %H:%M UTC")
COMMIT_SHORT=$(echo "$RELEASE_SHA" | cut -c1-8)

gh release create "$TAG" \
  --target "$RELEASE_SHA" \
  --title "Android ${VERSION_NAME} (versionCode ${NEW_BUILD})" \
  --notes "$(cat <<NOTES
## What's new

${CHANGES}

---

| Field | Value |
|---|---|
| **Version name** | ${VERSION_NAME} |
| **versionCode** | ${NEW_BUILD} |
| **Commit** | [\`${COMMIT_SHORT}\`](../../commit/${RELEASE_SHA}) |
| **Built** | ${BUILD_DATE} |
| **Track** | ${ANDROID_PLAY_DEFAULT_TRACK} |
| **Play Console** | [Open](https://play.google.com/console) |

> Uploaded to the **${ANDROID_PLAY_DEFAULT_TRACK}** track via the Play Developer API.
NOTES
)"
```

## Step 7 — report to the user

After the upload command returns success:
1. Tell the user the versionCode that shipped (e.g. "versionCode 202606010 uploaded to internal").
2. Name the track and note Play's processing time (internal: a few minutes; alpha/beta/production: review-gated, can be hours–days).
3. Confirm testers on that track will get the update automatically once processing completes.
4. Link to [play.google.com/console](https://play.google.com/console) so they can watch processing.

## One-time Play setup (per project / per machine)

Before the first `/playstore` run, four things must exist. These are operator steps — surface them and help where scriptable, but the user owns the Play Console and Google Cloud actions:

1. **Upload keystore** (per project, once):
   ```bash
   keytool -genkey -v -keystore "$ANDROID_KEYSTORE_PATH" \
     -alias "$ANDROID_KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000
   ```
   Store the passwords in `~/.android-signing/keystore.properties` (gitignored). Wire `app/build.gradle.kts` `signingConfigs.release` to read from it. Enroll in **Play App Signing** (recommended) so Google manages the app signing key and your upload key is only for uploads.

2. **Register the app in the Play Console** (per project, once): create the app under `com.shivaapps.photoai`, complete the store listing + content rating + data-safety form enough to enable an internal testing track, and **do the first upload through the Play Console UI** — the Publishing API will not accept uploads for a package that has never had a release created in the console.

3. **Play service account** (per project, once): create a Google Cloud service account, grant it access in Play Console → Users & permissions (at least "Release to testing tracks"), download its JSON to `$ANDROID_PLAY_SERVICE_ACCOUNT_JSON`.

4. **`googleapis` dependency** (per project, once): the uploader scripts ship with this skill and are generic, but they need the `googleapis` package resolvable from the consuming project — `npm i -D googleapis`. No per-project script authoring; `play-latest-build.mjs` / `play-upload-aab.mjs` / `play-lib.mjs` live in the skill dir and read the package id + service-account path from `android-config.sh`'s env (or `--package=` / `--service-account=` flags).

## Things to watch for

- **Never push to main from a feature branch as part of this flow.** The versionCode-bump commit is allowed because it's a chore commit on main, but per CLAUDE.md the user requires PR review for everything else. If there are unpushed feature commits, surface them and ask.
- **`versionCode` monotonicity is global per package** — every upload must be strictly greater than any previously-uploaded versionCode across ALL tracks, even rejected ones. Querying Play (Step 2) is the only reliable source.
- **AAB, not APK** — Play requires App Bundles for new apps. Don't `assembleRelease` (APK) for the upload; use `bundleRelease`.
- **Mappings file** — if R8/minification is on, upload the `mapping.txt` (`android/app/build/outputs/mapping/release/mapping.txt`) so Play/Crashlytics can de-obfuscate stack traces. The uploader script should attach it.
- **`production` track is never the default** — testing-track first, always. Promote to production only on explicit user request.
