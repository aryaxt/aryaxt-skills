# aryaxt-skills — plugin context

You are working on the **`aryaxt-skills` Claude Code plugin** — a shared
skill library installed across Aryan's projects (PhotoAI, ai-mini-app,
saas-template-derived). Changes here propagate to every project on next
`/plugin update`, so think carefully about backward compatibility.

## RULE: Keep the skill table in README.md current

When you add, remove, or rename a skill in `skills/`, update the table
in `README.md` in the same commit. Consumers (humans + AI) read README
to discover what the plugin offers; stale rows mislead.

## What this plugin is for

Generic, reusable workflows across Aryan's projects:

- iOS dev (`simulator`, `device`, `testflight`)
- Web dev (`chrome`)
- Firebase debugging (`error`)
- Ship workflows (`doit`, `create-issue`, `work-on-issue`)
- General utilities (`qa`, `free-space`, `decision-council`,
  `generate-image`)

## What it is NOT for

- Project-specific skills (PhotoAI's `/scenes`, `/add-style`,
  `/record-demo`). Those stay in the project's `.claude/skills/` because
  they depend on the project's schema, fine-tuned models, or business
  logic.
- One-off scripts. If a skill is only useful once, just write the bash
  inline rather than codifying it.

## Per-project config contract

iOS skills assume `scripts/ios-config.sh` exists in the consuming
project's root and exports `$IOS_BUNDLE_ID`, `$IOS_SCHEME`,
`$IOS_PROJECT_DIR`, `$IOS_PROJECT_NAME`, `$IOS_TEAM_ID`, plus the
optional `$IOS_SIM_BUILD_CACHE` / `$IOS_DEVICE_BUILD_CACHE` /
`$IOS_ARCHIVE_CACHE` derived-data paths.

Skills MUST source this file before using the variables. Don't bake
project-specific values into the skill markdown.

The bundled `appium` MCP server follows the same philosophy: the
plugin ships the launcher + server registration, but the app-specific
capabilities (bundle id, package, launcher activity) come from each
project's `.claude/appium/capabilities.json`, referenced via
`${CLAUDE_PROJECT_DIR}`. Don't bake a project's app ids into the plugin.

## Bundled MCP servers

The plugin-root `.mcp.json` declares MCP servers that start when the
plugin is enabled (`mcp/<name>/` holds their launchers/assets):

- `appium` — mobile UI automation (`appium-mcp`) for driving the iOS
  simulator / Android emulator. Launcher `mcp/appium/appium-mcp.sh`
  resolves Node (nvm) + `ANDROID_HOME` and execs the global install
  (`npm i -g appium-mcp@latest`). Per-project caps via
  `${CLAUDE_PROJECT_DIR}/.claude/appium/capabilities.json`
  (template: `mcp/appium/capabilities.example.json`).

When you add/change a bundled MCP server, update the README's
"Bundled MCP servers" table in the same commit (same rule as skills).
MCP/`.mcp.json` changes need `/reload-plugins` or a restart to take
effect — they don't hot-reload like `SKILL.md`.

## Versioning

Tag scheme: `vMAJOR.MINOR.PATCH` (`v0.1.0`, `v0.2.0`, etc.). Manifest
version in `.claude-plugin/plugin.json` mirrors the tag. Bump on every
breaking change (renamed skill, removed skill, changed config contract).

## Layout

```
aryaxt-skills/
├── .claude-plugin/
│   └── plugin.json          ← manifest (name, version, author)
├── README.md                ← human-readable skill index + install
├── CLAUDE.md                ← this file
└── skills/
    └── <name>/
        └── SKILL.md         ← skill file with YAML frontmatter
```
