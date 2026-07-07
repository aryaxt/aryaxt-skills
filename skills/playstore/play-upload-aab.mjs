#!/usr/bin/env node
// Uploads a signed Android App Bundle (.aab) to a Google Play track and rolls
// it out. The Android mirror of scripts/asc-assign-build.mjs.
//
// GENERIC / app-agnostic: per-project values come from CLI flags or environment
// (set by scripts/android-config.sh):
//   --package=<applicationId>   or  $ANDROID_APPLICATION_ID
//   --service-account=<path>    or  $ANDROID_PLAY_SERVICE_ACCOUNT_JSON
//
// Usage:
//   node <skill-dir>/play-upload-aab.mjs <aab-path> --track=internal --versionCode=202606010
//   node <skill-dir>/play-upload-aab.mjs app-release.aab --track=internal \
//        --versionCode=202606010 --mapping=mapping.txt --notes="Bug fixes"
//
// Flags:
//   --track=        internal (default) | alpha | beta | production
//   --versionCode=  the versionCode inside the AAB (sanity-checked against the
//                   uploaded bundle; required so a mismatch fails loudly)
//   --mapping=      optional R8/ProGuard mapping.txt for stack-trace de-obfuscation
//   --notes=        optional release notes (default: generic line)
//   --lang=         release-notes locale (default en-US)
//   --rollout=      production-only staged-rollout fraction 0..1 (default 1 = full)
//
// Flow: insert edit → upload bundle → (upload mapping) → set track release →
//       commit edit. Nothing is visible to testers until the commit succeeds.

import { existsSync } from "fs";
import { loadAndroidPublisher, parseCommonArgs, fail } from "./play-lib.mjs";

const { positional, packageName, serviceAccount, flag } = parseCommonArgs(process.argv.slice(2));

const aab = positional[0];
const track = flag("track") || process.env.ANDROID_PLAY_DEFAULT_TRACK || "internal";
const expectedVersionCode = flag("versionCode");
const mapping = flag("mapping");
const notes = flag("notes") || "Internal improvements and bug fixes.";
const lang = flag("lang") || "en-US";
const rollout = flag("rollout");

if (!aab) {
  console.error("usage: node play-upload-aab.mjs <aab-path> --track=internal --versionCode=<N>");
  process.exit(1);
}
if (!existsSync(aab)) {
  console.error(`AAB not found: ${aab}`);
  process.exit(1);
}
if (!packageName) {
  console.error("missing package: pass --package=<applicationId> or set ANDROID_APPLICATION_ID");
  process.exit(1);
}
// Validate --rollout loudly — a fat-fingered value must NOT silently fall through
// to a full rollout (or send the API an invalid userFraction:0).
let rolloutFraction = null;
if (rollout != null) {
  if (track !== "production") {
    console.error(`--rollout is only valid for --track=production (got track="${track}")`);
    process.exit(1);
  }
  const n = Number(rollout);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    console.error(`--rollout must be a number strictly between 0 and 1 (got "${rollout}")`);
    process.exit(1);
  }
  rolloutFraction = n;
}

const { createReadStream } = await import("fs");
const androidpublisher = await loadAndroidPublisher(serviceAccount);

let editId;
try {
  const edit = await androidpublisher.edits.insert({ packageName });
  editId = edit.data.id;
  console.log(`edit ${editId} opened for ${packageName}`);

  // 1) Upload the bundle.
  const up = await androidpublisher.edits.bundles.upload({
    packageName,
    editId,
    media: { mimeType: "application/octet-stream", body: createReadStream(aab) },
  });
  const versionCode = up.data.versionCode;
  console.log(`uploaded bundle — versionCode ${versionCode}`);

  if (expectedVersionCode && String(versionCode) !== String(expectedVersionCode)) {
    throw new Error(
      `versionCode mismatch: AAB contains ${versionCode} but --versionCode=${expectedVersionCode}. ` +
      `Bump android/app/build.gradle.kts and rebuild, or fix the flag.`
    );
  }

  // 2) Optional de-obfuscation mapping so Play/Crashlytics can symbolicate.
  if (mapping) {
    if (!existsSync(mapping)) throw new Error(`--mapping file not found: ${mapping}`);
    await androidpublisher.edits.deobfuscationfiles.upload({
      packageName,
      editId,
      apkVersionCode: versionCode,
      deobfuscationFileType: "proguard",
      media: { mimeType: "application/octet-stream", body: createReadStream(mapping) },
    });
    console.log(`uploaded mapping.txt for versionCode ${versionCode}`);
  }

  // 3) Assign to the track. Testing tracks roll out fully; production honors a
  //    validated --rollout (staged), else full ("completed").
  const release = {
    versionCodes: [String(versionCode)],
    releaseNotes: [{ language: lang, text: notes }],
  };
  if (rolloutFraction != null) {
    release.status = "inProgress";
    release.userFraction = rolloutFraction;
  } else {
    release.status = "completed";
  }

  // NOTE: edits.tracks.update REPLACES the track's entire release list (it is not
  // a merge). For internal/testing that's intended; for production with an
  // in-flight staged rollout this overwrites it — use tracks.patch if merge
  // semantics are ever needed.
  await androidpublisher.edits.tracks.update({
    packageName,
    editId,
    track,
    requestBody: { track, releases: [release] },
  });
  console.log(`assigned versionCode ${versionCode} to track "${track}" (status=${release.status}${release.userFraction ? `, rollout=${release.userFraction}` : ""})`);

  // 4) Commit — nothing above is live until this succeeds.
  // Play flip-flops on whether `changesNotSentForReview` is allowed, depending on
  // the app's current review configuration:
  //   - Some apps REQUIRE it (HTTP 400 "Changes cannot be sent for review
  //     automatically..." when it's absent).
  //   - Some apps REJECT it (HTTP 400 "Changes are sent for review automatically.
  //     The query parameter changesNotSentForReview must not be set.").
  // We can't know which regime an app is in ahead of time, so try WITHOUT the flag
  // first, and fall back to WITH it only when Play explicitly demands it. This
  // survives the app moving between regimes without a code change.
  let committed;
  try {
    committed = await androidpublisher.edits.commit({ packageName, editId });
  } catch (e) {
    const msg = String(e?.errors?.[0]?.message || e?.response?.data?.error?.message || e?.message || "");
    if (/cannot be sent for review automatically|changesNotSentForReview.*must be set/i.test(msg)) {
      committed = await androidpublisher.edits.commit({ packageName, editId, changesNotSentForReview: true });
    } else {
      throw e;
    }
  }
  editId = null; // committed edits must not be deleted
  console.log(`committed edit ${committed.data.id} — versionCode ${versionCode} is live on "${track}".`);
  console.log(`Play is now processing the bundle. Watch: https://play.google.com/console`);
} catch (e) {
  // Abandon the still-open edit BEFORE fail() — fail() calls process.exit(),
  // which skips finally, so cleanup has to happen here or the edit leaks.
  if (editId) {
    try { await androidpublisher.edits.delete({ packageName, editId }); } catch { /* best effort */ }
  }
  fail(e, packageName);
}
