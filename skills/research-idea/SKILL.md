---
name: research-idea
description: Run a 7-phase market research framework on a business idea before writing any code. Surfaces existing-pay evidence, market size, competitive landscape (including platform-risk check), differentiation, technical feasibility, go-to-market, and forces a GO / NO-GO decision via a scorecard. Use when the user proposes a new product or asks "should I build X?". Replaces the deprecated saas-template MCP research_idea tool.
---

# Research Idea — Pre-build market validation

## When to use this

The user is considering building a new product, app, or feature and asks any of:

- "Should I build X?"
- "Is X a good idea?"
- "What do you think about an app that does Y?"
- "Let me know if this is worth building before we start"

Do NOT skip this skill in favor of jumping to code. The cheapest mistake is the one you don't ship — research catches dead ideas before they consume weeks of build time.

## Execution rules

1. **Run every phase below in order.** Don't shortcut to phase 7 (the decision).
2. **Save findings as you go** to `<project-path>/docs/research/market-research.md` if a project path is known; else `./market-research.md` in the current directory.
3. **Use real web searches** — call `WebSearch` for the queries in each phase. Don't speculate; quote sources.
4. **Quote specific sources.** Every numeric claim (TAM, pricing, complaint volume) cites a URL.
5. **Red flags are halt-able.** If any "immediate NO-GO" trigger fires in phase 7, stop research and report — don't waste time on later phases.

## Phase 1 — Problem Validation

**Goal: confirm the problem exists AND people pay to solve it today.**

### Task 1.1 — Existing paid solutions

Run these searches (substitute `<IDEA>` with the user's idea, in quotes):

- `"<IDEA>" pricing`
- `"<IDEA>" cost`
- `"<IDEA>" service pricing 2026`

Answer:
- What do people pay TODAY to solve this manually? (specific dollar amounts)
- How often? (one-time / monthly / per-use)
- Is spending growing or shrinking?

🚩 **Red flag:** if nobody pays for manual solutions today, the problem isn't real enough.

### Task 1.2 — Social / forum demand

Run:
- `"<IDEA>" reddit`
- `"<IDEA>" complaints`
- `"<IDEA>" alternative`
- `"<IDEA>" wish existed`

Answer:
- Are people actively complaining? (exact pain points)
- Asking for alternatives? (what they want)
- How recent? (last 6 months = active market)

🚩 **Red flag:** complaints older than 1 year (or non-existent) = market moved on.

## Phase 2 — Market Sizing

**Goal: quantify opportunity.**

### Task 2.1 — TAM data

- `"<IDEA>" market size`
- `"<IDEA>" market size 2025 2026`
- `"<IDEA>" industry report`
- `"<IDEA>" TAM SAM SOM`

Answer:
- Total market size? (dollar amount)
- How many potential customers?
- Avg revenue per customer?
- Growth rate? (growing / flat / shrinking)

🚩 **Red flag:** TAM < $100M may be too small for venture-scale (fine for indie / lifestyle businesses).

### Task 2.2 — Willingness to pay for YOUR solution

- `"AI <IDEA>" pricing`
- `"<IDEA>" SaaS pricing`
- `"<IDEA>" subscription vs per-use`

Answer:
- Existing solutions' price points?
- Subscription or per-use pricing?
- Customer LTV?
- Price sensitivity evidence?

🚩 **Red flag:** existing AI solutions free or <$10/mo → monetization is hard.

## Phase 3 — Competitive Landscape — DEEP DIVE

**Goal: map every competitor, their strengths, weaknesses, trajectory.**

### Task 3.1 — Identify all competitors

- `"<IDEA>" competitors`
- `"<IDEA>" alternatives`
- `best "<IDEA>" software 2026`
- `"<IDEA>" vs`
- `"<IDEA>" review 2026`
- `"<IDEA>" ProductHunt`
- `"<IDEA>" G2 reviews`

For each (minimum 10): name, URL, pricing, funding, team size, launch date, what users praise, what they complain about, growing or stagnating, well-funded?

🚩 **Red flag:** well-funded competitor with product-market fit = you need a VERY clear differentiator.

### Task 3.2 — Platform-risk check (CRITICAL)

- `"<IDEA>" built-in feature`
- `"<IDEA>" native integration`
- `Google "<IDEA>" AI`
- `Apple "<IDEA>" AI`
- `Microsoft "<IDEA>" AI`

Answer:
- Are Google / Apple / Amazon / industry leaders adding this as a built-in feature?
- If yes — what's the timeline? launched or announced?
- Would platform integration make standalone tools obsolete?

🚩 **CRITICAL red flag:** if a dominant platform is building this for free, the standalone market will collapse. This killed the dating-photo and virtual-staging ideas. **If this fires, stop — go directly to phase 7 and trigger NO-GO.**

### Task 3.3 — Competitor weaknesses

- `"<IDEA>" complaints`
- `"<IDEA>" problems`
- `"<IDEA>" missing features`
- `"<IDEA>" sucks reddit`

Answer:
- Top 5 complaints across all competitors?
- Consistently-requested features nobody provides?
- Underserved customer segment?
- Pricing model gap?

🚩 **Red flag:** if competitors are well-liked with few complaints, there's not enough pain to switch.

## Phase 4 — Differentiation Analysis

**Goal: determine if you can win and WHY.**

### Task 4.1 — Define your unique advantage

- What can you do that competitors can't or won't?
- Is your advantage technical / experiential / economic / positional?
- Is it defensible (3-month copy test)?
- Would a customer switch from current to yours? Why specifically?
- Can you articulate the advantage in ONE sentence?

🚩 **Red flag:** if your only edge is "better UX" or "slightly cheaper", it's not enough. Copyable in weeks.

### Task 4.2 — Validate the moat

- What prevents copying?
- Do you have: proprietary data / network effects / switching costs / brand / regulatory advantage?
- When AI models improve, does your advantage grow or shrink?
- If Pieter Levels built this tomorrow, would you still have a chance?

🚩 **Red flag:** Pieter Levels test fails → moat too thin.

## Phase 5 — Technical Feasibility

**Goal: confirm you can build at the required quality.**

### Task 5.1 — Core capability

- `"<IDEA>" AI model`
- `"<IDEA>" API`
- `"<IDEA>" Replicate model`
- `"<IDEA>" open source`
- `"<IDEA>" technical approach`

Answer:
- What AI models / APIs would you use?
- Cost per request / image / generation?
- Quality good enough for professional use TODAY (not "will be soon")?
- Known failure modes?
- Can you build a prototype in 1-2 weeks?

🚩 **Red flag:** AI quality isn't there yet = betting on future improvements.

### Task 5.2 — Unit economics

- Cost per customer action?
- What would you charge? (Based on competitor pricing)
- Gross margin?
- Profitable at 100 customers? At 1000?

🚩 **Red flag:** gross margins below 60% = business model may not scale.

## Phase 6 — Go-To-Market

**Goal: confirm you can reach customers efficiently.**

### Task 6.1 — Customer acquisition

- Who is your ideal first customer? (role, company size, industry — be specific)
- Where do they hang out online? (subreddits, forums, FB groups, Slack)
- Launch strategy? (ProductHunt, communities, cold outreach, content)
- Estimated CAC?
- Viral / referral loop?

🚩 **Red flag:** can't name 3 specific places where customers congregate → GTM will be hard.

## Phase 7 — GO / NO-GO Decision

**Goal: make the final call based on ALL prior phases.**

### Must-have for GO (score YES/NO for each)

- [ ] People currently pay real money to solve this manually
- [ ] No dominant platform is building this in for free
- [ ] Clear, defensible advantage articulable in ONE sentence
- [ ] AI/tech quality is good enough TODAY (not "will be soon")
- [ ] Gross margins above 60%
- [ ] Can name 3+ specific places to reach customers

### Yellow flags (count them)

- Well-funded competitor exists but hasn't won yet
- Market is growing but competitive
- Advantage is primarily UX/price (copyable)
- Requires customer education (they don't know they need this yet)

### Immediate NO-GO triggers

- A dominant platform is offering this for free
- A well-funded competitor with product-market fit dominates
- Underlying AI quality isn't production-ready
- Your only advantage is "I can build it too"
- The market is shrinking

### Decision logic

- **Any immediateNOGO trigger** → **NO-GO, full stop**
- **All must-haves YES + yellow flags ≤ 2** → **strong GO**
- **1–2 must-haves NO** → **conditional GO** (address the gaps first)
- **3+ must-haves NO** → **NO-GO**

## Output — the research document

After all phases, save (and present) a document with these sections:

1. **Executive Summary** — GO/NO-GO with one-paragraph justification
2. **Problem Validation** — evidence people pay for this (cite sources)
3. **Market Size** — TAM, growth rate, customer count
4. **Competitive Landscape** — table of ALL competitors with pricing, traction, strengths, weaknesses
5. **Platform Risk** — are major platforms building this in?
6. **Differentiation** — your unique advantage and moat
7. **Technical Feasibility** — approach, costs, quality assessment
8. **Unit Economics** — cost per action, pricing, gross margin
9. **Go-To-Market** — customer profile, channels, launch strategy
10. **Risk Assessment** — table: risks × severity × mitigation
11. **Decision Matrix Scorecard** — must-haves YES/NO, yellow-flag count, immediate NO-GO check
12. **Final Decision with Conditions** — if conditional GO, what needs to be true before starting

Save to `<project-path>/docs/research/market-research.md` (if a project exists) or `./market-research.md`.

## After the decision

- **GO** → run `/aryaxt:plan-features` to translate the validated idea into an implementation plan
- **Conditional GO** → resolve the named gaps first, then re-run this skill
- **NO-GO** → save the doc anyway; it's valuable artifact for the next idea (you can reference "we already evaluated and killed X" later)

## What this skill replaces

The deprecated saas-template MCP server's `research_idea` tool. Same content, different delivery vector — the MCP server is being removed.
