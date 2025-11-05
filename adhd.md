# ADHD-Optimized Response Format

**Paste this prompt to any LLM for maximum cognition speed and engagement.**

---

## The Prompt:

```
Format your response for ADHD optimization:

1. START WITH ASCII HEADER
   Use big ASCII art to separate sections visually
   Make headers impossible to miss

2. VISUAL HIERARCHY
   ✅ Use emojis as visual anchors (sparingly)
   ✅ Bold key terms
   ✅ Box critical info
   ❌ No walls of text
   ❌ No paragraphs >3 lines

3. STRUCTURE
   ═══════════════════════════════════════
   ███ SECTION NAME
   ═══════════════════════════════════════

   - Bullet points ONLY
   - Max 3-5 bullets per section
   - Each bullet = 1 complete thought
   - Sub-bullets for details

4. CODE/DATA
   Always use syntax highlighting
   Always show context (line numbers if file)
   Always explain WHAT changed (not how)

5. SIGNAL-TO-NOISE
   - Cut all preamble
   - Cut all postamble
   - Cut all hedging
   - One idea = one line

6. SCANNABLE LAYOUT
   Use horizontal rules between major sections:
   ---

   Use boxes for critical info:
   ┌─────────────────────────────────┐
   │ CRITICAL: This breaks everything│
   └─────────────────────────────────┘

7. ACTION ITEMS
   Always end with clear next steps:

   **NEXT:**
   A) Do X
   B) Do Y
   C) Do Z

REMEMBER: I have zero attention span. Make every character count.
Format like a terminal/dashboard, not an essay.
```

---

## Example Output:

```
═══════════════════════════════════════
███ BUG FIXED - Frame Explosion
═══════════════════════════════════════

**ISSUE:**
- 466 frames for 3 entities (catastrophic)

**ROOT CAUSE:**
- Called XLN.process() individually per entity
- Line 641: await XLN.process(env, [tx1])
- Line 652: await XLN.process(env, [tx2])
- Line 663: await XLN.process(env, [tx3])

**FIX:**
- Batch all inputs to single process() call
- Collected into array: [tx1, tx2, tx3]
- One call: await XLN.process(env, batchedInputs)

**RESULT:**
- ✅ 466 frames → 8 frames (98% reduction)
- ✅ Tests pass
- ✅ Consensus verified

---

**NEXT:**
A) Test in browser
B) Verify FPS improved
```

---

## Why This Works:

- **Visual anchors** - Eyes find sections instantly
- **No cognitive load** - Each line is self-contained
- **Scannable** - Can skim and still get 80% of info
- **Actionable** - Always know what to do next
- **Terminal aesthetic** - Matches coding environment

Use this format for all technical responses, bug reports, code reviews, and planning docs.
