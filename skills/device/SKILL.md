---
name: device
description: Build and install the iOS app on a real iPhone or iPad connected by USB or Wi-Fi. Use whenever the user types /device, says "install on my phone", "run on my iphone", "install on device", "test on real device", "push to my phone", "deploy to ipad", "run on connected phone", or any variant of "install it on my actual phone/ipad/device". Optional positional arg: a device name fragment (e.g. "iphone", "arya's phone"); with no arg, picks the first available paired device. USB and Wi-Fi devices are treated the same once paired in Xcode. If no device is connected, surface a clear "no paired device found" message and stop.
---

# /device — build and install the iOS app on a real iPhone/iPad

The iOS app lives at `ios/DatingAIAssistant.xcodeproj` (scheme `DatingAIAssistant`, bundle id `com.shivaapps.photoai`, team `C5GK8X5LBQ`, automatic signing). This skill builds for a connected device and installs + launches it via `xcrun devicectl`.

USB and Wi-Fi devices look identical to `devicectl` once they're paired in Xcode — we don't have to do anything different for the two transports. The user pairs once via Xcode → Window → Devices and Simulators → "Connect via network", and from then on the device shows up in `devicectl list devices` whenever it's awake on the same network.

## Step 1 — parse the target

Argument can be:
- *(none)* — pick the first **available paired** device returned by `devicectl`
- A name fragment (case-insensitive substring) — e.g. `iphone`, `arya`, `ipad pro`. Match against the device `Name` column.

There's no `all` mode for devices: physical installs interactively prompt for trust on first run and codesign races aren't worth fighting. If the user wants two devices, run the skill twice.

## Step 2 — list connected devices

```bash
xcrun devicectl list devices 2>&1
```

Parse the output. The columns are `Name | Hostname | Identifier | State | Model`. We want rows where `State` is `available (paired)` or `connected`. The `Identifier` column is the UDID we feed to subsequent commands.

If the output contains an authentication-prompt error or `No provider was found`, that's a Core Devices setup quirk that does **not** block our usage — devices still list. Don't panic on that line; only fail if no devices appear.

```bash
# Drop header lines, keep paired/connected rows, then filter by user's fragment
DEVICES=$(xcrun devicectl list devices 2>/dev/null \
  | awk 'NR>2 && $0 !~ /^---/ && NF>=4')

# If a name fragment was given, narrow it down (case-insensitive)
if [ -n "$ARG" ]; then
  MATCH=$(echo "$DEVICES" | grep -i -- "$ARG" | head -1)
else
  MATCH=$(echo "$DEVICES" | head -1)
fi

if [ -z "$MATCH" ]; then
  echo "No paired iOS device found. Connect by USB, or for Wi-Fi pair via Xcode → Window → Devices and Simulators → check 'Connect via network'. The device must be unlocked."
  exit 1
fi

# Pull the UDID and human name. Identifier is a UUID with hex+dashes; isolate it,
# then the name is everything before it.
DEVICE_UDID=$(echo "$MATCH" | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1)
DEVICE_NAME=$(echo "$MATCH" | awk '{print $1}')
```

If multiple devices match a fragment, prefer the first one but mention in the final confirmation which one was picked, so the user knows if they meant the other.

## Step 2b — fix worktree saas-template symlink (if applicable)

iOS SPMs from `saas-template` (`Components`, `ErrorReporting`, `AppCheckProvider`, `PushNotifications`, …) are wired in `ios/project.yml` as `path: ../../saas-template/packages/<Name>`. That path resolves from the main repo but **NOT from a worktree** (`.claude/worktrees/<name>/ios/` → `.claude/worktrees/saas-template/...` which doesn't exist).

Symlink the worktree-peer location to the real saas-template before `xcodebuild` runs, otherwise it errors with `Invalid local package "Components"` and friends.

```bash
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
GIT_COMMON_ABS=$(cd "$WORKTREE_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
PARENT_REPO=$(dirname "$GIT_COMMON_ABS")

if [ "$PARENT_REPO" != "$WORKTREE_ROOT" ]; then
  SAAS_SOURCE="$(dirname "$PARENT_REPO")/saas-template"
  SAAS_PEER="$(dirname "$WORKTREE_ROOT")/saas-template"
  if [ -d "$SAAS_SOURCE" ] && [ ! -e "$SAAS_PEER" ]; then
    ln -s "$SAAS_SOURCE" "$SAAS_PEER"
  fi
fi
```

If `$SAAS_SOURCE` doesn't exist, skip — the user doesn't consume saas-template SPMs and `xcodebuild` will fail loudly with a clearer message than we could produce.

## Step 3 — build for device

Use a stable derived-data path so successive runs hit the cache. Run in background — first build is 2–4 min, subsequent are 15–45s. Note the build folder is **`Debug-iphoneos`** (not `Debug-iphonesimulator`).

**Worktree note:** if running from a worktree (`.claude/worktrees/<name>/`), the saas-template SPM paths (`../../saas-template/packages/...` in `ios/project.yml`) don't resolve. Symlink the peer location first (same pattern `/chrome` uses for `.env.local`):

```bash
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
GIT_COMMON_ABS=$(cd "$WORKTREE_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
PARENT_REPO=$(dirname "$GIT_COMMON_ABS")
if [ "$PARENT_REPO" != "$WORKTREE_ROOT" ]; then
  SAAS_SOURCE="$(dirname "$PARENT_REPO")/saas-template"
  SAAS_PEER="$(dirname "$WORKTREE_ROOT")/saas-template"
  [ -d "$SAAS_SOURCE" ] && [ ! -e "$SAAS_PEER" ] && ln -s "$SAAS_SOURCE" "$SAAS_PEER"
fi
```

Then:

```bash
xcodebuild \
  -project ios/DatingAIAssistant.xcodeproj \
  -scheme DatingAIAssistant \
  -configuration Debug \
  -destination "generic/platform=iOS" \
  -derivedDataPath /tmp/datingai-device-build \
  -allowProvisioningUpdates \
  build
```

Why these flags:
- `generic/platform=iOS` — compile once for any iOS device. We don't pin to the UDID at build time because the artifact works on any compatible device with a valid provisioning profile, and pinning sometimes makes Xcode try to "prepare" the device, which fails if it's locked.
- `-allowProvisioningUpdates` — lets Xcode auto-fetch / refresh the development profile for `com.shivaapps.photoai` from the configured team. Without it, a stale profile is a hard error.

If the build fails:
- **Code signing** ("No profile matching ... was found", "Provisioning profile doesn't include..."). Tell the user: "Open Xcode once, sign in to your Apple ID under Settings → Accounts if needed, and let it generate a profile for team `C5GK8X5LBQ`." Don't try to hand-edit `project.pbxproj` to fix this.
- **Device not registered** ("...device with identifier `<UDID>` is not registered"). Open Xcode → Window → Devices and Simulators, plug in the device once, and accept the trust prompt on the phone. After that, automatic signing will register it.
- **Real Swift compile error** — surface the actual diagnostic. Don't try to "fix" it without showing the user.

## Step 4 — install

```bash
APP=$(find /tmp/datingai-device-build/Build/Products/Debug-iphoneos -maxdepth 2 -type d -name "DatingAIAssistant.app" | head -1)
[ -z "$APP" ] && { echo "Build succeeded but .app not found at expected path"; exit 1; }

xcrun devicectl device install app --device "$DEVICE_UDID" "$APP"
```

Common failures and what to surface:
- **"Device is locked"** — tell the user to unlock the phone and re-run. (Wi-Fi devices in particular tend to be asleep when you start.)
- **"The developer is not trusted"** — first install on a new device requires the user to go to Settings → General → VPN & Device Management → tap the developer cert → Trust. Surface this verbatim; we can't fix it from the command line.
- **Long pauses on Wi-Fi installs are normal.** A first install over Wi-Fi can take 30–90s for a debug build of this size; don't time out aggressively.

## Step 5 — launch

```bash
xcrun devicectl device process launch --device "$DEVICE_UDID" --terminate-existing com.shivaapps.photoai
```

`--terminate-existing` matches what Xcode does on Run: kill any prior instance so the user sees a fresh launch, not whatever stale state was already there.

If launch fails with "App is not installed" right after a successful install, the device may have a stale CoreDevice cache — re-running the install usually clears it.

## Step 6 — confirm

One short sentence:

> *"Installed and launched DatingAIAssistant on iPhone (UDID 2702BB16…)."*

Use the device name from Step 2 so the user knows which phone got it. If they had multiple devices paired, this is the only signal that we picked the right one.

## Notes

- **Don't shut down or restart the device when done.** The user is mid-test.
- **Bundle ID `com.shivaapps.photoai`, scheme `DatingAIAssistant`, team `C5GK8X5LBQ`** — read from `ios/DatingAIAssistant.xcodeproj/project.pbxproj`. If any of these change, update this skill.
- **Wi-Fi pairing is one-time per device.** After "Connect via network" is checked in Xcode for a device, it shows up in `devicectl list devices` over either transport for the lifetime of that pairing. The user does not need to keep a USB cable connected.
- **First-time-on-this-device flow is interactive.** The user has to trust the developer cert in Settings on the phone the first time only. There's no command-line bypass; surface the instruction and stop.
- **Don't use the Xcode MCP's `BuildProject`** — same reason as the simulator skill: the destination is whatever Xcode last had selected, which is non-deterministic. Use `xcodebuild` with explicit `-destination "generic/platform=iOS"`.
- **`/tmp/datingai-device-build` is intentionally separate from `/tmp/datingai-sim-build`** so that running `/simulator` and `/device` back-to-back doesn't force either to do a full SwiftPM resolve.
