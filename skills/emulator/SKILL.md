---
name: emulator
description: Build and launch the Android app on an emulator. Use when the user types /emulator, says "run on the android emulator", "launch on android", "test on the emulator", "fire it up on android", "show it to me on android", or any variant of running the app on Android. Thin alias for the `simulator` skill's Android path (equivalent to `/simulator android`).
---

# /emulator — build and run the Android app on an emulator

Convenience alias for the `simulator` skill's Android path.

Invoke the `simulator` skill (`aryaxt:simulator`) via the Skill tool with the
argument `android`, forwarding any extra args the user passed (e.g. an explicit
AVD name like `/emulator Pixel_8_API_35` → `simulator Pixel_8_API_35` on the
Android path).

All the actual work — pick the AVD, boot it, ensure the dev server on
`10.0.2.2:3000`, `./gradlew :app:installDebug`, launch — lives in the
`simulator` skill's "Android — build and run the app on an emulator" section.
Keep this skill a one-line delegate so the procedure stays in exactly one place.
