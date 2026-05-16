---
name: error
description: Use when a user reports an app/backend failure ("why is X failing", "it's not working", "something went wrong", "check the logs"). Queries the `errorLogs` Firestore collection via the Firebase MCP to surface the real root cause — not just the generic 500 the client sees.
---

# Check Latest Error Logs

When the user reports a failure, don't guess — check the `errorLogs` Firestore collection. Every server-side catch in this codebase calls `logError()` from `src/lib/services/error-log-service.ts`, and the iOS `APIClient` also reports every HTTP / decode error to `/api/errors/report`. The real cause is almost always in there.

## How to query

Use the Firebase MCP tool `mcp__plugin_firebase_firebase__firestore_query_collection`:

```
collection_path: errorLogs
filters: []
order: { orderBy: "createdAt", orderByDirection: "DESCENDING" }
limit: 10
```

If the Firebase MCP is not connected, ask the user to run `claude mcp list` and verify the firebase plugin is set up, or fall back to `firebase firestore:query` CLI if they have it.

## Document shape

```
{
  source: string,        // e.g. "astria-service:createTraining",
                         //      "api:models:[modelId]:train:POST",
                         //      "ios:api"
  message: string,       // human-readable error message
  stack: string,         // full stack trace (server) or Swift error (iOS)
  platform: "server" | "ios" | "web",
  metadata: {
    userId?: string,
    modelId?: string,
    apiPath?: string,
    statusCode?: number,
    responseBody?: string,
    clientStack?: string,
    ...anything the logger attached
  },
  createdAt: Timestamp
}
```

## The correlation pattern — always look BELOW the top result

A single failure usually produces **multiple** rows in rapid succession (within ~1 second), and the *top* row is typically the least informative. The client's "something failed" log lands last. Scroll down to find the actual cause.

Example of a single Astria-balance failure, in reverse chronological order:

1. **ios:api** `Failed to start model training` · statusCode 500 · `/api/models/{id}/train` — *generic, unhelpful*
2. **api:models:[modelId]:train:POST** `Astria createTraining failed (422): {"base":["Not enough balance..."]}` — *real cause on our side*
3. **astria-service:createTraining** same 422 — *origin of the failure*

**Report the deepest (earliest) entry as the root cause**, then explain how it surfaced up the stack into the client error the user actually saw. Otherwise the user reads "Failed to start model training" and thinks it's an app bug — when it's actually (in this example) the developer's Astria account being out of balance.

## Filtering down to the right failure

If the collection is noisy and you need to zero in:

- **By user:** `filters: [{ field: "metadata.userId", op: "EQUAL", compare_value: { string_value: "<uid>" } }]`
- **By platform:** `filters: [{ field: "platform", op: "EQUAL", compare_value: { string_value: "server" } }]` — skip iOS surface-level noise, see only server-side causes
- **By time window:** if the user tells you approximately when, filter with `GREATER_THAN` on `createdAt` (pass an ISO date string via `string_value`). Last 10 minutes is usually enough to catch the incident.
- **By source prefix:** Firestore doesn't support `startsWith` directly, but you can order by `source` and use `GREATER_THAN_OR_EQUAL` / `LESS_THAN` with the prefix range.

Getting the user's uid: if they're logged into the running app, check `authVM.currentUser?.id` in iOS code, or the dashboard. Or just look at the most recent entry — it'll have a userId.

## Reporting format to the user

Don't dump the raw log dict. Synthesize:

1. **One-sentence root cause** ("Your Astria account is out of balance — not your user's app credits.")
2. **The actual error message** verbatim, in a code block, so they can search for it
3. **The call chain** — which layer surfaced the error up to which — so they understand why the user-visible message is unhelpful
4. **Actionable next step** — fix Astria balance, fix server mapping, fix decode schema, etc.
5. **Any parallel bugs** you noticed in adjacent log rows — offer to fix them but don't silently expand scope

## Before proposing a fix — mandatory due diligence

A single error log entry is a clue, not a verdict. Before suggesting or writing any fix:

**1. Verify the root cause — don't assume**
- Is this error recurring or a one-off? Query a wider time window to check frequency.
- Could this be expected behaviour (e.g. a user deleting a resource mid-flight, a test run, a bot probe)?
- Does the log chain show the *actual* origin or only a surface-level symptom? Look for earlier entries within the same second — the deepest one is the real cause.
- If only one entry exists and context is thin, say so honestly rather than stating a confident root cause.

**2. Read the code before touching it**
- Read the full route/service file where the error originates, not just the line in the stack trace.
- Understand what the function is *supposed* to do and what invariants it maintains.
- Check callers — how is this function invoked and what guarantees do callers make?
- Check if similar patterns exist elsewhere in the codebase that would also need the same fix.

**3. Validate the fix is not a hack**

| Red flag | What it usually means |
|---|---|
| Adding a `try/catch` that swallows the error | Hiding the bug, not fixing it |
| Switching `.update()` → `.set()` without understanding why the doc is missing | May mask a creation bug upstream |
| Adding a null-check without understanding why null is possible | The real bug is the null — fix that instead |
| Returning early / no-op on missing data | Silently skips work the caller expects to have happened |
| Hardcoding a fallback value | Almost always wrong; find the source of truth |

The fix should address *why* the bad state occurred, not just defend against it at the point of failure.

**4. Assess impact before writing code**
- What other code paths call the function being changed?
- Could the fix affect happy-path behaviour (not just the error case)?
- Does the change affect any data written to Firestore / sent to the client / sent to a third-party API?
- Are there iOS or web clients that depend on the current response shape or status codes?

**5. When uncertain, ask — don't patch**
If the root cause is ambiguous after reading the code, say what you found and what you'd need to know before fixing it. A confident wrong fix is worse than no fix.

## Things to watch for

- **Swallowed errors**: some catches only `console.error` / `print` without writing to `errorLogs`. If the user says "it failed silently", the collection may be empty — grep for `catch` without `logError()` in the suspect route.
- **iOS decode errors**: `NSCocoaErrorDomain code=4865` / "No value associated with key" means server response shape doesn't match a Swift `Decodable`. These show up with `responseBody` in metadata so you can compare.
- **Self-reporting loop**: the `/api/errors/report` endpoint itself skips logging to avoid infinite loops, so a broken error-report endpoint won't surface in `errorLogs` — check server logs (Cloud Run / App Hosting) directly for that.
