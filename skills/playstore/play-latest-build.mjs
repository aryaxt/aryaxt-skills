#!/usr/bin/env node
// Prints the highest versionCode currently reserved for a package on Google
// Play — across ALL tracks' releases AND every uploaded bundle (assigned or
// not). The Publishing API rejects a duplicate or non-increasing versionCode,
// and a versionCode is "used" the moment a bundle is uploaded, even if it was
// never assigned to a track or the release was later halted. Querying both
// surfaces is the only reliable source for "what to bump past".
//
// GENERIC / app-agnostic: nothing about a specific app is baked in. Per-project
// values come from CLI flags or environment (set by scripts/android-config.sh):
//   --package=<applicationId>   or  $ANDROID_APPLICATION_ID
//   --service-account=<path>    or  $ANDROID_PLAY_SERVICE_ACCOUNT_JSON
//
// Usage:
//   node <skill-dir>/play-latest-build.mjs
//   node <skill-dir>/play-latest-build.mjs --package=com.foo.bar --service-account=/path/sa.json
//   node <skill-dir>/play-latest-build.mjs --json     # machine-readable output
//
// Output (human): the highest versionCode + where it came from.
// Output (--json): { "highestVersionCode": N, "byTrack": {...}, "uploadedBundles": [...] }
//
// Read-only: it inserts an edit to query, then abandons it (never commits).

import { loadAndroidPublisher, parseCommonArgs, fail } from "./play-lib.mjs";

const { args, packageName, serviceAccount, json } = parseCommonArgs(process.argv.slice(2));

const androidpublisher = await loadAndroidPublisher(serviceAccount);

let editId;
try {
  const edit = await androidpublisher.edits.insert({ packageName });
  editId = edit.data.id;

  const byTrack = {};
  let highest = 0;

  // 1) versionCodes live in each track's releases
  const tracks = await androidpublisher.edits.tracks.list({ packageName, editId });
  for (const t of tracks.data.tracks ?? []) {
    const codes = (t.releases ?? []).flatMap(r => (r.versionCodes ?? []).map(Number));
    if (codes.length) {
      byTrack[t.track] = codes.sort((a, b) => b - a);
      highest = Math.max(highest, ...codes);
    }
  }

  // 2) bundles.list returns every uploaded .aab — a versionCode is reserved at
  //    upload time even if it was never assigned to a track. Without this an
  //    uploaded-but-unassigned bundle would collide on the next upload.
  let uploadedBundles = [];
  try {
    const bundles = await androidpublisher.edits.bundles.list({ packageName, editId });
    uploadedBundles = (bundles.data.bundles ?? []).map(b => Number(b.versionCode)).sort((a, b) => b - a);
    if (uploadedBundles.length) highest = Math.max(highest, ...uploadedBundles);
  } catch {
    // bundles.list can 404 on a brand-new app with no uploads yet — fine.
  }

  if (json) {
    console.log(JSON.stringify({ highestVersionCode: highest, byTrack, uploadedBundles }, null, 2));
  } else {
    console.log(`package:           ${packageName}`);
    console.log(`highest versionCode: ${highest || "(none — no releases or uploads yet)"}`);
    for (const [track, codes] of Object.entries(byTrack)) {
      console.log(`  track ${track}: ${codes.join(", ")}`);
    }
    if (uploadedBundles.length) console.log(`  uploaded bundles: ${uploadedBundles.join(", ")}`);
    console.log(`\nnext build: bump versionCode to a value greater than ${highest || 0}.`);
  }
  // Read-only — discard the edit so it never lingers / accidentally commits.
  if (editId) {
    try { await androidpublisher.edits.delete({ packageName, editId }); editId = null; } catch { /* best effort */ }
  }
} catch (e) {
  // fail() calls process.exit(), which skips finally — abandon the edit here.
  if (editId) {
    try { await androidpublisher.edits.delete({ packageName, editId }); } catch { /* best effort */ }
  }
  fail(e, packageName);
}
