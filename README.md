# aryaxt-skills

Aryan's shared Claude Code skills. Lives as a single plugin so updates
propagate to every project (PhotoAI, ai-mini-app, saas-template-derived
apps) via one git push instead of N copy-pastes.

## Install

```
/plugin marketplace add aryaxt/aryaxt-skills
/plugin install aryaxt-skills@aryaxt
```

After install, skills are namespaced: invoke as `/aryaxt:simulator`,
`/aryaxt:testflight`, etc.

If you want the short forms (`/simulator`, `/testflight`) for muscle
memory, add a 1-line wrapper skill in your project's `.claude/skills/`:

```markdown
---
name: simulator
description: Wrapper — calls aryaxt:simulator
---
Invoke `aryaxt:simulator` with any args passed by the user.
```

## What's in here

| Skill | What it does |
|---|---|
| `simulator` | Build + launch iOS app on iPhone/iPad simulator. |
| `emulator` | Build + launch Android app on an emulator (alias for `simulator android`). |
| `device` | Build + install on a real device. |
| `testflight` | Bump build, archive, upload to App Store Connect. |
| `chrome` | Boot Next.js dev server + open in Chrome. |
| `doit` | Review local/committed changes → split PRs → multi-agent review → merge. |
| `qa` | Per-feature visual smoke test on iOS simulator via computer-use. |
| `error` | Query Firestore `errorLogs` to find the real root cause behind a 500. |
| `free-space` | Clean Xcode DerivedData, npm cache, etc. |
| `create-issue` | Create a richly-labeled GitHub issue on the project board. |
| `work-on-issue` | Autonomous loop: read issue → branch → plan → implement → test → PR. |
| `decision-council` | Spawn 3 adversarial subagents for biased framing problems. |
| `generate-image` | Generate AI photos via the project's Gemini setup. |
| `create-project` | Scaffold a new SaaS project from `saas-template`: copy → rename → 16-step Firebase + GitHub + deploy onboarding. **Replaces the deprecated saas-template MCP `create_project` tool.** |
| `research-idea` | Run a 7-phase market research framework on a business idea before writing code. Forces a GO / NO-GO decision via a scorecard. Run BEFORE building. **Replaces the deprecated saas-template MCP `research_idea` tool.** |
| `plan-features` | Translate a validated product idea (post `research-idea`) into a per-task implementation plan, prioritized mvp / v1 / v2. **Replaces the deprecated saas-template MCP `plan_features` tool.** |

## Per-project config

All iOS skills source `$PROJECT_ROOT/scripts/ios-config.sh` at the start
to pick up project-specific values:

```bash
export IOS_BUNDLE_ID="com.shivaapps.photoai"
export IOS_SCHEME="DatingAIAssistant"
export IOS_PROJECT_DIR="ios"
export IOS_TEAM_ID="C5GK8X5LBQ"
```

Each project ships its own `scripts/ios-config.sh`. The plugin's skill
files reference `$IOS_BUNDLE_ID` etc. as variables — they don't bake
values in.

If you don't have `scripts/ios-config.sh` yet, either create one (copy
from any saas-template-based project) or export the variables in your
shell rc.

## What's NOT in here

Project-specific skills stay in the project's `.claude/skills/`:

- PhotoAI: `/scenes`, `/add-style`, `/record-demo` (depend on PhotoAI's
  schema, scene catalog, fine-tuned models)
- Anything that references a project's business logic or proprietary data

If you find yourself wanting a new skill that's generic, add it here
and update the table above. If it's project-specific, keep it local.
