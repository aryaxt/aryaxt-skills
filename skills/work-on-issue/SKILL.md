---
name: work-on-issue
description: Use when the user asks to work on, implement, or pick up a GitHub issue by number. Fully autonomous loop: reads the issue, moves the kanban card, creates a branch, plans + implements + tests, opens a PR, and moves the card to Review.
---

# Work On Issue

Fully autonomous implementation loop for a GitHub issue. No check-ins during execution — Claude implements, reviews, and opens the PR. The human reviews and merges.

## Invocation

```
/work-on-issue 42
```

## Steps

### 1. Read the issue

```bash
gh issue view <#> --repo <your-org>/<your-repo> \
  --json title,body,labels,number
```

Parse the title, Summary, Context, Acceptance Criteria, and Implementation Notes sections. If the issue is missing critical information to start, post a comment on the issue asking for clarification, then stop and tell the user.

### 2. Move card → In Progress

```bash
# Get project number (cache for session)
PROJECT_NUMBER=$(gh project list --owner <your-gh-owner> --format json \
  | jq '.projects[] | select(.title=="<your-project-name>") | .number')

# Get the item ID for this issue on the board
ITEM_ID=$(gh project item-list "$PROJECT_NUMBER" --owner <your-gh-owner> --format json \
  | jq --arg url "$(gh issue view <#> --repo <your-org>/<your-repo> --json url -q .url)" \
    '.items[] | select(.content.url==$url) | .id')

# If not on the board yet — add it
if [ -z "$ITEM_ID" ]; then
  ISSUE_URL=$(gh issue view <#> --repo <your-org>/<your-repo> --json url -q .url)
  ITEM_ID=$(gh project item-add "$PROJECT_NUMBER" --owner <your-gh-owner> --url "$ISSUE_URL" --format json | jq -r '.id')
fi

# Get Status field ID and "In Progress" option ID
STATUS_META=$(gh project field-list "$PROJECT_NUMBER" --owner <your-gh-owner> --format json \
  | jq '.fields[] | select(.name=="Status")')
FIELD_ID=$(echo "$STATUS_META" | jq -r '.id')
OPTION_ID=$(echo "$STATUS_META" | jq -r '.options[] | select(.name=="In Progress") | .id')
PROJECT_ID=$(gh project list --owner <your-gh-owner> --format json | jq -r '.projects[] | select(.title=="<your-project-name>") | .id')

gh project item-edit \
  --id "$ITEM_ID" \
  --project-id "$PROJECT_ID" \
  --field-id "$FIELD_ID" \
  --single-select-option-id "$OPTION_ID"
```

### 3. Create feature branch

Branch naming: `issue-<#>-<slug>` where slug = first 3 words of the issue title, lowercased, hyphenated.

```bash
git checkout main
git pull --ff-only origin main
git checkout -b issue-<#>-<slug>
```

Examples:
- Issue #12 "Add video duration picker" → `issue-12-video-duration-picker`
- Issue #5 "Fix LoRA face leaking" → `issue-5-fix-lora-face`

### 4. Plan implementation

Invoke `superpowers:writing-plans` with the issue title, body, and relevant files identified in Context. Follow the plan exactly.

### 5. Implement with TDD

Invoke `superpowers:test-driven-development`. Write tests first (red), then implementation (green), then refactor.

### 6. Simplify

After implementation is complete, invoke `simplify` on all changed files.

### 7. Verify — do NOT skip

Run the test suite:
```bash
npm test -- --passWithNoTests
npm run build
```

**If tests fail:** fix them before proceeding. Do NOT open a PR with red tests.

### 8. Code review

Invoke `superpowers:requesting-code-review`. Provide the issue context and all changed files. Resolve any blocking issues before opening the PR.

### 9. Open PR

```bash
gh pr create \
  --repo <your-org>/<your-repo> \
  --title "<issue title>" \
  --body "$(cat <<'EOF'
## Summary
<1–2 sentence summary of what was built>

## Changes
<bullet list of changed files and what changed>

## Test plan
- [ ] <what to test manually>
- [ ] Automated tests pass

Closes #<n>

🤖 Generated with [Claude Code](https://claude.ai/claude-code)
EOF
)" \
  --base main
```

### 10. Move card → Review

Repeat the `gh project item-edit` from Step 2, but use the **Review** option ID instead of In Progress.

### 11. Report to user

Post the PR URL and a one-line summary: "PR opened for issue #<n>: <title>. Ready for your review."

---

## Failure handling

| Situation | Action |
|-----------|--------|
| Issue has no Acceptance Criteria | Infer from title + Summary; list them in the PR body so user can verify |
| Tests fail after implementation | Fix before PR — never open with red tests |
| Build fails | Fix before PR |
| Code review flags blocking issues | Fix inline; re-run review |
| Issue not on board | Auto-add in Step 2 |
| Branch already exists | Check if there's existing work; resume from where it left off |

---

## What the user does after

1. Review the PR on GitHub
2. Request changes or approve
3. Merge the PR
4. Move the kanban card to **Done**
