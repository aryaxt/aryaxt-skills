---
name: free-space
description: Use when the user asks to free up disk space on their Mac — "free some space", "make some room", "I'm running out of disk", "clean up my drive", "/free-space", or any variant of "the disk is full". Scans known regenerable caches (Xcode DerivedData, CoreSimulator, npm, Homebrew, etc.), picks the biggest safe wins, clears them in the background, and reports the before/after. Does NOT touch source code, project files, or the user's home directory contents outside the cache list below.
---

# Free disk space (macOS dev machine)

Goal: get the user the GiB they asked for, fast, without nuking anything they actually need. On a dev machine with Xcode, the answer is almost always **Xcode DerivedData** — start there.

## Workflow

1. **Capture current free space** so you can report a delta at the end:
   ```bash
   df -h /System/Volumes/Data
   ```

2. **Scan the known cache locations in one batch.** Don't `du` the whole home directory — full-tree scans take minutes and aren't needed.
   ```bash
   du -sh \
     ~/Library/Developer/Xcode/DerivedData \
     ~/Library/Developer/Xcode/Archives \
     ~/Library/Developer/Xcode/iOS\ DeviceSupport \
     ~/Library/Developer/CoreSimulator/Caches \
     ~/Library/Developer/CoreSimulator/Devices \
     ~/Library/Caches \
     ~/Library/Caches/Homebrew \
     ~/.npm \
     ~/.cache \
     ~/.Trash \
     2>/dev/null
   ```

3. **Pick the biggest safely-deletable target(s).** Sort the scan output by size and reach for the green-tier items first. If a single item alone gets the user past their target, stop there — don't over-clean.

   | Path | Tier | Side effect of deleting |
   |------|------|--------------------------|
   | `~/Library/Developer/Xcode/DerivedData` | Safe | First Xcode build of each project is slow (rebuild + reindex) |
   | `~/Library/Caches/Homebrew` | Safe | `brew install` re-downloads bottles |
   | `~/.npm` | Safe | First `npm install` after is slower |
   | `~/.cache` | Safe | App-specific; usually harmless |
   | `~/Library/Developer/CoreSimulator/Caches` | Safe | Simulator rebuilds caches on next launch |
   | `~/Library/Developer/Xcode/iOS DeviceSupport` | Safe | Xcode re-downloads symbols when a device next attaches |
   | `~/Library/Caches` (broad) | Mostly safe | Many apps regenerate; may lose some thumbnails/indexes |
   | `~/Library/Developer/Xcode/Archives` | **Confirm** | Wipes shipped TestFlight/App Store archives — those hold dSYMs needed to symbolicate production crash reports |
   | `~/Library/Developer/CoreSimulator/Devices` | **Confirm** | Deletes simulator state, installed apps, login sessions. The user keeps an iPhone 17 simulator alive — never delete this without explicit OK |
   | `~/.Trash` | **Confirm** | Files are gone for good; user may have meant to recover something |
   | Anything not on this table | **Confirm** | Out of scope — ask first |

4. **Run the rm in the background.** Multi-GB deletes take 30–90 seconds and you don't want to block. Use `Bash` with `run_in_background: true`:
   ```bash
   rm -rf ~/Library/Developer/Xcode/DerivedData/* && df -h /System/Volumes/Data
   ```
   Wait for the completion notification rather than polling.

5. **Report the delta.** Format like: "Free space: 3.3 GiB → 42 GiB (cleared 51 GB of Xcode DerivedData)." Mention any side effects in one line ("first Xcode build of each project will be slow").

## Don't

- **Don't** ask permission for the green-tier items (DerivedData, Homebrew cache, npm cache, `~/.cache`, simulator caches) — the user already asked for free space; just do it and report.
- **Don't** delete `~/Library/Developer/CoreSimulator/Devices` — wiping it kills the iPhone 17 simulator the user keeps running.
- **Don't** delete `~/Library/Developer/Xcode/Archives` without confirming. Those archives contain dSYMs for shipped builds; without them, production crash reports can't be symbolicated.
- **Don't** empty `~/.Trash` without confirming.
- **Don't** `du -sh ~` or `du -sh /` — too slow, not needed.
- **Don't** touch anything under `~/Desktop/Repos/`, `~/Documents/`, `~/Downloads/`, or any project working directory. Those are user files.
- **Don't** keep cleaning past the target. If the user said "5 GB" and DerivedData freed 50, you're done.

## Why DerivedData is almost always the answer

On an active Xcode project that's been built across many branches and configurations, DerivedData routinely hits 30–80 GB. It's per-build intermediates and indexes, fully regenerable, and Apple's own clean-build button just deletes it anyway. It's the highest-yield safe target on any Mac with Xcode installed. Always check it first; usually you won't need to look further.
