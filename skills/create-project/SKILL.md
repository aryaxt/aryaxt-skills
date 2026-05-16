---
name: create-project
description: Scaffold a new Next.js + Firebase + iOS SaaS project from the saas-template monorepo. Walks through 16 guided onboarding steps (Firebase setup, env vars, GitHub repo, deploy). Use when the user says "create a new project", "scaffold a new app", "start a new project from saas-template", or similar. Replaces the deprecated saas-template MCP create_project tool.
---

# Create Project — Scaffold a new app from saas-template

## When to use this

User wants a brand-new SaaS project. They give you:
1. A project name (kebab-case, e.g. `real-estate-ai`)
2. A target path (absolute, e.g. `~/Desktop/Repos/real-estate-ai`)

You scaffold the project, run guided onboarding to wire Firebase + deploy, and report what was done.

## Prerequisites

- `saas-template` cloned at `~/Desktop/Repos/saas-template` (the canonical sibling-repo location)
- `gh` CLI installed + authenticated (`gh auth status`)
- Firebase MCP available (tools named `mcp__plugin_firebase_firebase__*`) — load via ToolSearch if deferred
- User logged in to Firebase CLI (`firebase login`)

If any prerequisite is missing, stop and tell the user before scaffolding anything.

## Step 1 — Validate inputs

```bash
# Validate name is kebab-case
[[ "$NAME" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "Name must be kebab-case (lowercase + dash)"; exit 1; }

# Validate path doesn't exist
[ ! -e "$PATH" ] || { echo "Path $PATH already exists — refusing to overwrite"; exit 1; }

# Validate saas-template clone is present
[ -d "$HOME/Desktop/Repos/saas-template/template" ] || { echo "saas-template clone missing at expected location"; exit 1; }
```

If the path exists AND it's already a saas-template-derived project (look for `.saas-template.json`), tell the user the project exists and offer to resume onboarding. Otherwise refuse.

## Step 2 — Validate the template has the required files

Before copying, verify these critical files exist in `saas-template/template/`:

```
package.json, tsconfig.json, next.config.ts, postcss.config.mjs,
.gitignore, .env.example, src/app/globals.css, src/app/layout.tsx,
src/app/page.tsx, src/middleware.ts
```

If any are missing, stop and tell the user the template itself is broken — they need to fix saas-template before creating projects.

## Step 3 — Copy the template

```bash
cp -r ~/Desktop/Repos/saas-template/template <TARGET_PATH>
cd <TARGET_PATH>
```

## Step 4 — Rename project-specific text

Run these substitutions to replace `saas-template` / `SaaS Kit` / `SaaS Template` with the project name:

```bash
# package.json — use jq or node to preserve formatting
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.name = '<PROJECT_NAME>';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"

# Markdown + YAML — straight sed
for f in CLAUDE.md AGENTS.md apphosting.yaml; do
  [ -f "$f" ] && sed -i.bak "s/saas-template/<PROJECT_NAME>/g" "$f" && rm "$f.bak"
done

# Landing components
sed -i.bak \
  -e "s/SaaS Kit/<PROJECT_NAME>/g" \
  -e "s|/generate|/dashboard|g" \
  -e "s|/gallery|/locations|g" \
  src/components/landing/landing-nav.tsx src/components/landing/footer.tsx \
  src/components/layout/navbar.tsx 2>/dev/null
rm src/components/landing/*.bak src/components/layout/*.bak 2>/dev/null
```

For `src/app/layout.tsx` — the template has product-specific marketing copy that needs hand-editing later. Replace the title / description for now with `${PROJECT_NAME} — Built with SaaS Template`.

## Step 5 — Wire saas-template package deps

The template consumes `@aryaxt/*` NPMs via `file:` paths. Verify `package.json` already has them:

```jsonc
"@aryaxt/admin-shell": "file:../saas-template/npm-packages/admin-shell",
"@aryaxt/auth": "file:../saas-template/npm-packages/auth",
"@aryaxt/error-reporting": "file:../saas-template/npm-packages/error-reporting",
"@aryaxt/iap": "file:../saas-template/npm-packages/iap",
"@aryaxt/iap-admin": "file:../saas-template/npm-packages/iap-admin",
"@aryaxt/push-notifications": "file:../saas-template/npm-packages/push-notifications",
"@aryaxt/app-check": "file:../saas-template/npm-packages/app-check"
```

The `file:` paths assume the standard sibling-repo layout — `<TARGET_PATH>` and `~/Desktop/Repos/saas-template` are filesystem siblings. If `<TARGET_PATH>` is somewhere else, the `file:` references won't resolve. Tell the user and offer to fix the paths or relocate.

## Step 6 — Write the project tracking file

Create `<TARGET_PATH>/.saas-template.json`:

```json
{
  "templateVersion": "2.0.0",
  "createdAt": "<ISO timestamp>",
  "templateRepo": "/Users/aryaxt/Desktop/Repos/saas-template",
  "onboarding": { "completed": false, "currentStep": 0 }
}
```

(The pre-2.0 schema had `installedModules` + `fileOrigins` for the dead `improve_template` flow. Drop those — they're not used anymore.)

## Step 7 — Install + git init

```bash
cd <TARGET_PATH>
npm install
git init
git add -A
git commit -m "Initial commit from saas-template"
```

## Step 8 — Walk through onboarding (16 steps)

For each step: announce it, do automated steps via the listed MCP tool / shell command, wait for user confirmation on manual steps. Update the tracking file's `onboarding.currentStep` after each.

**Step 1 — Create Firebase project**
- Automated via `mcp__plugin_firebase_firebase__firebase_create_project` with `{ project_id: <name>, display_name: <name> }`
- If project ID taken: append `-app` and retry. **Save the actual project ID** — all subsequent steps use it.

**Step 2 — CRITICAL: Switch Firebase MCP to the new project**
- Automated via `mcp__plugin_firebase_firebase__firebase_update_environment` with `{ project_dir: <target>, active_project: <projectId> }`
- Skipping this means all subsequent Firebase ops happen on the wrong project. Verify the response confirms the switch.

**Step 3 — User enables billing** (manual)
- Open: `https://console.developers.google.com/billing/enable?project=<projectId>`
- REQUIRED for Firestore + Storage. Wait for explicit user confirmation before proceeding.

**Step 4 — User enables Firestore API** (manual)
- Open: `https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=<projectId>`
- Wait for user confirmation.

**Step 5 — Create Firestore database**
- Automated via `mcp__plugin_firebase_firebase__firestore_create_database` with `{ parent: "projects/<projectId>", databaseId: "(default)", database: { locationId: "nam5", type: "FIRESTORE_NATIVE" } }`
- If fails on "API not enabled" or "billing required", go back to steps 3-4. Verify creation at `https://console.firebase.google.com/project/<projectId>/firestore`.

**Step 6 — User enables Google Auth** (manual)
- Open: `https://console.firebase.google.com/project/<projectId>/authentication/providers`
- Authentication → Sign-in method → Google → Enable. Set support email. Wait for user confirmation.

**Step 7 — Create Firebase web app**
- Automated via `mcp__plugin_firebase_firebase__firebase_create_app` with `{ platform: "web", display_name: "<projectName> Web" }`

**Step 8 — Get SDK config + write .env.local**
- Automated via `mcp__plugin_firebase_firebase__firebase_get_sdk_config` with `{ platform: "web" }`
- Write the returned values into `<target>/.env.local` using the standard `NEXT_PUBLIC_FIREBASE_*` keys:
  - `apiKey` → `NEXT_PUBLIC_FIREBASE_API_KEY`
  - `authDomain` → `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
  - `projectId` → `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
  - `storageBucket` → `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
  - `messagingSenderId` → `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
  - `appId` → `NEXT_PUBLIC_FIREBASE_APP_ID`
- Also update `apphosting.yaml` with the same values.

**Step 9 — User generates service account key** (manual)
- Open: `https://console.firebase.google.com/project/<projectId>/settings/serviceaccounts/adminsdk`
- Click "Generate new private key" → download JSON → add the entire JSON contents on one line as `FIREBASE_SERVICE_ACCOUNT_KEY` in `.env.local`.
- Wait for confirmation.

**Step 10 — Initialize Firebase config files**
- Automated via `mcp__plugin_firebase_firebase__firebase_init` with:
  ```json
  { "features": {
      "firestore": { "database_id": "(default)", "location_id": "nam5" },
      "auth": { "providers": { "googleSignIn": { "oAuthBrandDisplayName": "<name>", "supportEmail": "<userEmail>" }, "emailPassword": true } },
      "storage": {}
  } }
  ```

**Step 11 — Create GitHub repo + push**
- Automated: `cd <target> && gh repo create <name> --private --source=. --push`
- Requires `gh` CLI installed + authenticated.

**Step 12 — (OPTIONAL — was MCP step) Skip GitHub Actions template-sync setup**
- The old `improve_template` flow is deprecated. New projects don't need template-sync secrets in GitHub Actions.
- Mention this to the user and skip.

**Step 13 — Apple In-App Purchase setup** (manual, if monetization needed)
- The template uses `@aryaxt/iap` for Apple IAP (no Stripe).
- Direct user to App Store Connect to create products + the App Store Server API key. Save env vars: `APPLE_BUNDLE_ID`, `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_PRIVATE_KEY`, `APPLE_ASC_KEY_ID`, `APPLE_ASC_ISSUER_ID`, `APPLE_ASC_PRIVATE_KEY`, `APPLE_APP_ID`.
- Wait for user confirmation. (Skip entirely if the user doesn't want IAP.)

**Step 14 — Deploy Firestore security rules**
- Automated: `cd <target> && npx firebase deploy --only firestore:rules --project <projectId>`
- REQUIRED — without this, all Firestore client ops fail with "Missing or insufficient permissions".

**Step 15 — Verify the app runs locally**
- Automated: `cd <target> && npm run dev`
- Open `http://localhost:3000`. Verify:
  - Landing page renders with dark theme
  - Sign-in with Google works
  - Dashboard loads after sign-in
- If landing page is unstyled: check `postcss.config.mjs` exists.
- If "Missing or insufficient permissions": re-run step 14.

**Step 16 — Optional: Firebase App Hosting auto-deploy**
- Manual: visit `https://console.firebase.google.com/project/<projectId>/apphosting` to enable, then:
- `npx firebase apphosting:backends:create --project <projectId> --backend <name>-backend --primary-region us-central1`
- Update `apphosting.yaml` with secrets.

## Step 9 — Mark onboarding complete

Update `.saas-template.json`:
```json
{ "onboarding": { "completed": true, "currentStep": 16 } }
```

## Step 10 — Tell the user what packages are available

The saas-template ships **10 SPMs + 7 NPMs**. The template's `package.json` already wires the relevant NPMs. For iOS, the user adds SPMs by editing `ios/project.yml` (if they add an iOS target later). List the available packages with one-line descriptions:

| Package | Type | Use case |
|---|---|---|
| Components | SPM | iOS design tokens + primitives |
| Auth | SPM | iOS headless sign-in |
| AuthUI | SPM | iOS login screens |
| AppCheckProvider | SPM | iOS App Attest |
| ErrorReporting | SPM | iOS error reporter |
| PushNotifications | SPM | iOS push registration |
| HamburgerMenu | SPM | iOS menu primitives |
| DebugMenu | SPM | iOS DEBUG-only dev sheet |
| IAP | SPM | iOS StoreKit 2 service |
| IAPUI | SPM | iOS paywall + math helpers |
| `@aryaxt/admin-shell` | NPM | Admin tab framework |
| `@aryaxt/auth` | NPM | Server auth helpers |
| `@aryaxt/app-check` | NPM | App Check middleware |
| `@aryaxt/error-reporting` | NPM | Error logging + admin queries |
| `@aryaxt/iap` | NPM | Apple IAP server (validate, webhook, ASC sync) |
| `@aryaxt/iap-admin` | NPM | Admin Revenue tab |
| `@aryaxt/push-notifications` | NPM | Device registration + send helpers |

Per-package docs at `~/Desktop/Repos/saas-template/{packages,npm-packages}/<name>/CLAUDE.md`.

## Critical rules during scaffolding

- **NEVER rewrite landing page components from scratch.** The template ships fully-styled with a dark-theme design system. Customize only TEXT CONTENT (headlines, descriptions, stats). Do NOT change `className`, layout, or structure.
- **NEVER use hardcoded Tailwind colors.** All components use semantic tokens: `bg-surface`, `text-heading`, `bg-accent`, `border-edge`, etc. The design system is in `src/app/globals.css` under `@theme inline`.
- **Use the design system tokens** when adding any new UI. See the project's `CLAUDE.md` for the full token list.
- **Dispatching subagents to customize the UI?** Always include: "Read the existing files first. Only change text content — do NOT rewrite component structure, styling, or className attributes. The design system uses CSS custom properties + semantic Tailwind tokens that MUST be preserved."

## What this skill replaces

The deprecated saas-template MCP server's `create_project` tool. The MCP server is being removed; this skill is the supported path for new projects.

## What this skill does NOT do

- `add_module` — modules/ is being phased out in favor of packages. Most "modules" are already packages; the rest will be extracted. To add a package: `npm install` (NPM) or add to `ios/project.yml` (SPM).
- `improve_template` — deprecated. Edit packages directly under `~/Desktop/Repos/saas-template/{packages,npm-packages}/` and open a PR there.
- `update_project` — deprecated. `npm update @aryaxt/*` (web) or bump SPM tag references (iOS).
