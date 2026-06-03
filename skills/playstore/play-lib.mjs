// Shared plumbing for the Play uploader scripts — auth, arg parsing, errors.
// GENERIC: no app-specific values. Lives in the skill dir so every consuming
// app uses the same logic; per-project values arrive via flags / env.

import { readFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { join } from "path";

// Resolve `googleapis` whether it's installed in the skill dir OR (more likely,
// since the scripts are app-agnostic) in the consuming project's node_modules.
// Walk: bare import (skill-local) → createRequire from the project cwd.
export async function loadGoogleapis() {
  try {
    return await import("googleapis");
  } catch {
    try {
      const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
      return await import(pathToFileURL(require.resolve("googleapis")));
    } catch {
      console.error(
        "missing dependency: googleapis\n" +
        "  install it in the consuming project:  npm i -D googleapis\n" +
        "  (the uploader resolves it from the project's node_modules)"
      );
      process.exit(1);
    }
  }
}

// Authenticated androidpublisher client from a service-account JSON key file.
export async function loadAndroidPublisher(serviceAccountPath) {
  if (!serviceAccountPath || !existsSync(serviceAccountPath)) {
    console.error(
      `Play service-account JSON not found: ${serviceAccountPath || "(unset)"}\n` +
      "  set ANDROID_PLAY_SERVICE_ACCOUNT_JSON (scripts/android-config.sh) or pass --service-account=<path>"
    );
    process.exit(1);
  }
  const { google } = await loadGoogleapis();
  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountPath,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  return google.androidpublisher({ version: "v3", auth });
}

// Parse the flags common to both scripts. Positional (non---) args are returned
// in `positional` for the caller (e.g. the AAB path) to pick up.
export function parseCommonArgs(argv) {
  const flag = (name, fallbackEnv) => {
    const hit = argv.find(a => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(`--${name}=`.length);
    return fallbackEnv ? process.env[fallbackEnv] : undefined;
  };
  return {
    args: argv,
    positional: argv.filter(a => !a.startsWith("--")),
    json: argv.includes("--json"),
    packageName: flag("package", "ANDROID_APPLICATION_ID"),
    serviceAccount: flag("service-account", "ANDROID_PLAY_SERVICE_ACCOUNT_JSON"),
    flag,
  };
}

// Friendly mapping of the Publishing API's common, opaque errors.
export function fail(e, packageName) {
  const msg = e?.errors?.[0]?.message || e?.message || String(e);
  const status = e?.code || e?.response?.status;
  console.error(`Play API error${status ? ` (HTTP ${status})` : ""}: ${msg}`);
  if (/permission/i.test(msg) || status === 401 || status === 403) {
    console.error(
      "  → the service account lacks release access, or the JSON is for the wrong Google Cloud project.\n" +
      "    Play Console → Users & permissions → grant at least \"Release to testing tracks\"."
    );
  } else if (status === 404 || /not\s*found/i.test(msg)) {
    console.error(
      `  → package "${packageName}" has no release the API can see.\n` +
      "    The FIRST upload for a package must be done by hand through the Play Console UI;\n" +
      "    only after that will the Publishing API accept uploads."
    );
  }
  process.exit(1);
}
