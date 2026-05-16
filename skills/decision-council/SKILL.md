---
name: decision-council
description: Use when facing a non-trivial design or scope decision where you suspect your own framing is biased — e.g. "should we include X in this PR?", "is approach A or B better here?", "is my scope too wide/narrow?". Spawns 3 adversarial-role subagents under strict bias controls, then a synthesis pass, and returns a structured recommendation. Do NOT use for factual lookups, trivial choices, or questions you already have full context and clear reasoning on — there it adds noise.
---

# Decision Council

A structured way to use subagents as advisors **without** the false rigor of "spawn 3 Claudes and vote." Three Claudes are not three independent thinkers — they're one thinker sampled three times from correlated priors. Naive multi-agent voting produces noise pretending to be signal.

This skill enforces six guardrails that make the technique actually useful, then runs a synthesis pass that catches what all advisors missed.

## When to use it

**Good fits:**
- Scope decisions where you suspect anchoring ("am I making this PR too big?")
- A vs B design choices with multiple legitimate framings
- Questions where you have a known bias you can name (over-engineering, over-shipping, over-testing)
- "Is my whitelist / interface / abstraction at the right level?"

**Bad fits — DO NOT use:**
- Factual lookups (just look it up)
- Decisions where you have full context and clear reasoning (advisors add noise, not signal)
- Trivial / time-pressured choices (overhead exceeds value)
- Anything where the right answer is obvious to a careful reader

If in doubt, ask: *"Do I genuinely not know which way to go, and is this important enough that being wrong has real cost?"* If both yes → use it. Otherwise skip.

## The six guardrails

These exist because of the failure modes of naive subagent voting. Every step of the workflow below enforces one or more of them. Do not skip steps.

1. **Separate premise from conclusion.** Strip every "I'm leaning toward...", "the current plan is...", "I think X is better" from the prompt. The advisor must not see your tentative answer or even hints of it. If the framing encodes the answer, the advisor will defend it.

2. **Adversarial roles, not duplicate roles.** Three "senior engineers" returns one answer three times. Use roles with **genuinely different value functions**: ship-velocity, production-safety, long-term-maintainability, user-experience, security-paranoid, scope-minimizer. Pick three that would naturally disagree on this specific decision.

3. **Context completeness gate.** Before spawning, list what an advisor needs to know to be useful. If you can't supply it, the advisor is guessing — abort or supply more context. Better to spawn one well-briefed advisor than three context-starved ones.

4. **Hide the proposer.** Do not say "Claude proposed this", "I'm thinking", or anything that signals which option came from an authority figure in the conversation. Frame as a neutral artifact under review. Removes the deference cue.

5. **Explicit permission to disagree.** Every advisor prompt ends with: *"If this is the wrong frame, say so directly. If neither option is right, propose a third. Hedging or 'it depends' without a recommendation is failure."* Measurably reduces sycophancy.

6. **Synthesis pass with a different prompt.** After collecting opinions, a final agent gets only the *opinions* (not the original framing) and asks: "What did all three advisors miss that someone with full context might catch?" This catches shared blind spots — the failure mode where all three Claudes confidently agreed because they share the same prior.

## Workflow

### Step 1 — Frame the question (you, not the agent)

Write down, in your own words:

- **The decision** (one sentence, no preferred option)
- **The constraints** (what's fixed, what's negotiable)
- **The stakes** (what's the cost of getting it wrong each direction?)
- **Your honest gut** (write this for yourself only — DO NOT include it in advisor prompts)

If you cannot write a one-sentence neutral version of the decision, the question is too vague. Refine it first.

### Step 2 — Pick three adversarial roles

Choose roles whose value functions would lead them to *disagree* on this specific question. Examples:

| Decision type | Suggested adversarial trio |
|---|---|
| Scope ("include in this PR?") | scope-minimizer / future-maintainer / risk-auditor |
| Architecture (A vs B) | simplicity-maximizer / extensibility-advocate / operational-realist |
| Test coverage depth | shipping-pragmatist / regression-paranoid / cost-conscious |
| API design | api-consumer / implementer / breaking-change-auditor |

The roles must have **named priorities that conflict on this question**. If you can't articulate why role A and role B would disagree, pick different roles.

### Step 3 — Assemble context

List every file, prior decision, and constraint the advisors need. Concrete checklist:

- [ ] Relevant source files (paths + what's in them)
- [ ] Existing tests / patterns the decision must fit alongside
- [ ] Project conventions from CLAUDE.md / AGENTS.md that bear on this
- [ ] Prior related decisions (PRs, issues, commits)
- [ ] What's been tried and ruled out

If you cannot fill these in, **stop**. Advisors without context produce confident guessing. Either gather the context or downgrade to spawning one well-briefed advisor.

### Step 4 — Spawn the three advisors (parallel)

Send a single message with three Agent tool calls. Each prompt follows this template strictly:

```
You are reviewing a decision as a [ROLE]. Your priority is [VALUE FUNCTION]. You are NOT a generalist — argue from your role's perspective even if it makes you unpopular.

# The decision
[Neutral one-sentence statement of the question. NO preferred option, NO "I'm thinking", NO "the current plan".]

# Options on the table
- Option A: [neutral description]
- Option B: [neutral description]
[Do NOT order options to signal preference. Randomize the order across the three advisor calls if you can.]

# Context you need
[Files, conventions, prior decisions, constraints. Paste the actual content if short; reference paths if long.]

# Your task
1. Argue from your role's perspective. Do not pretend to be neutral.
2. Pick a recommendation. "It depends" or hedging is failure.
3. If neither option is right, propose a third.
4. Name the strongest argument AGAINST your own recommendation. (This is the steel-thread test — if you can't articulate it, you haven't thought hard enough.)
5. Under 300 words.

If the question is malformed, the framing is wrong, or you need more context, say so directly — do not paper over it.
```

Use `subagent_type: general-purpose`. Run all three in **one message with parallel tool calls** — sequential runs let the second and third advisors implicitly anchor on the first if any state leaks.

### Step 5 — Read the three responses

Look for:

- **Did all three converge?** Real signal — but also possible shared blind spot. Continue to synthesis.
- **Did they split?** Read the disagreement. Often the disagreement *is* the answer (it surfaces the actual tradeoff).
- **Did one or more refuse to commit?** That's a signal the question is malformed. Reframe and retry rather than forcing a vote.
- **Did one propose a third option?** Take it seriously — third options often dominate when both A and B encode a hidden assumption.

### Step 6 — Synthesis pass

Spawn ONE more agent with `subagent_type: general-purpose`. Give it ONLY the three opinions (with role labels) and the original neutral question. **Do NOT give it your framing, your gut, or any "the current plan" tells.**

Prompt:

```
Three reviewers analyzed the following decision from different perspectives. Their opinions are below.

# The decision
[Same neutral statement.]

# Reviewer 1 ([role])
[full text of opinion]

# Reviewer 2 ([role])
[full text]

# Reviewer 3 ([role])
[full text]

# Your task
1. What did ALL THREE reviewers miss? Each was constrained by their role; what would a generalist with full context catch?
2. Is the question itself well-formed, or are the options encoding a false binary?
3. Give a final recommendation in 2 sentences with the single most important reason. If you'd recommend something different from all three reviewers, say so.

Under 250 words. Direct prose. No hedging.
```

### Step 7 — Decide

You — not the synthesis agent — make the call. Read all four outputs and decide. The skill produces input to YOUR judgment, not a verdict.

When reporting back to the user, include:
- The decision you made
- Which advisor's framing most influenced you (or "synthesis caught X all three missed")
- The strongest counter-argument you're accepting

**Do not** present the council's outputs as the answer. They are advisors. You are the decider.

## Anti-patterns

If you find yourself doing any of these, stop and reset:

- ❌ "Three agents agreed, so the answer is X" — correlated samples, not independent votes
- ❌ Listing your preferred option first or describing it more favorably
- ❌ Three advisors with the same role ("senior engineer", "expert", "reviewer")
- ❌ Spawning advisors without the context inventory step
- ❌ Skipping synthesis because the three converged ("they all agreed, easy")
- ❌ Letting the synthesis agent see your original framing
- ❌ Using the council on a question you already have a confident answer to (advisors will mostly confirm; you've burned time and cache)
- ❌ Using the council under time pressure when you should just decide

## Cost note

This skill spawns 4 subagent calls. Reserve it for decisions where being wrong has real cost — scope creep on a sensitive PR, architectural lock-in, security boundaries. For most decisions, just decide.
