# JEV harness best practices: where the call sits

Scope is TypeSafe's published docs as opened on 2026-10-03, starting from [llms.txt](https://docs.typesafe.ai/llms.txt). No product source was read. Cookbook accuracy figures below stay attached to the cookbook that printed them. Example thresholds (0.3, 0.5, 0.6, 0.85, and the rest) are local to the page that uses them. The docs say to plot confidence against accuracy on your own data; they do not publish a harness-wide cutoff.

Pages opened:

- [llms.txt](https://docs.typesafe.ai/llms.txt)
- [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md)
- [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)
- [Primitives (Questions)](https://docs.typesafe.ai/primitives.md)
- [Choice](https://docs.typesafe.ai/primitives/choice.md)
- [Score](https://docs.typesafe.ai/primitives/score.md)
- [Noul](https://docs.typesafe.ai/primitives/noul.md)
- [Intent routing](https://docs.typesafe.ai/patterns/intent-routing.md)
- [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md)
- [Function calling](https://docs.typesafe.ai/cookbooks/function_calling.md)
- [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md)
- [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)
- [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails.md)
- [Classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md)
- [Models](https://docs.typesafe.ai/models.md)

## Where does the call sit relative to the model turn? Who executes the chosen function?

### Takeaway

The docs put the JEV call in the harness, outside the chat model's generation. JEV returns a typed judgment and does not call tools, write the reply, or choose its own next action. The harness reads that judgment and then either runs the chosen function itself or routes to an LLM, a person, or a refusal. The one measured agent recipe that still involves a chat model calls JEV before the turn and only then, optionally, pastes a suggestion into the system prompt.

### Cited Findings

Practice: do not replace the chat model with JEV, and do not expect JEV to stream text, call tools, or edit files. Sentence: "Jev is **not** a drop-in replacement for the LLM behind Claude Code, Cursor, opencode, Copilot, Muse Spark, Grok Bot, or similar tools." The next sentences: "It does not generate text, write code, or hold a conversation. It takes a [state](https://docs.typesafe.ai/concepts/state) and a set of typed [questions](https://docs.typesafe.ai/primitives) and returns structured answers your code can use directly." And: "Coding agents rely on an LLM that streams text, calls tools, and edits files based on natural-language instructions. Jev does none of that. There is no `model: "jev-latest"` setting that turns your coding agent into a Jev-powered agent, because the two systems solve different problems." — [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md), headings "Jev with coding agents" and "Jev is not a chat or code-completion LLM".

Practice: the harness author uses JEV inside the app or agent for routing, classification, scoring, and guardrails. Sentence: "Use Jev inside an app or agent you're building — for routing, classification, scoring, guardrails, or any structured decision." The same page's "when to reach for it" list starts: "Route a request to one of a fixed set of destinations, and know how confident that routing is." It also says to "Replace a fragile prompt that asks an LLM to "return JSON" with a call that returns typed values by construction." — [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md), headings "What you probably want instead" and "When Jev is worth reaching for".

Practice: code owns control flow, side effects, and the decision of what to do with the answer. Sentence: "System One is TypeSafe's model for building AI-powered software, not agents. It does not generate code or choose its own next action. It provides AI primitives that embed into software, so code remains in control while the model handles common-sense judgments over unstructured data." Summary bullets: "Keep control flow, deterministic rules, and side effects in code." The LLM-agents column says: "An agent processes instructions and chooses its next step. This works well when a person is monitoring the process, but every loop introduces another opportunity to go off the rails." The AI-powered-software column says: "Code handles deterministic work and owns the control flow. The model appears only where the system needs programmable common sense or needs to interpret unstructured data. Each AI task is kept atomic and constrained." — [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), headings "How to build with TypeSafe" and "Three software architectures".

Practice: call JEV only for the unstructured judgment, then branch in ordinary code, including skipping the call when the state is already deterministic. The worked ticket function comments: "Handle deterministic states without calling a model." Then one `system_one` call, then "Compose independent spam signals with weights controlled by code," "Escalate uncertain judgments instead of guessing," and "Let code decide which speculative answers matter on this path." The surrounding prose: "This support-ticket workflow keeps deterministic work in code, sends only relevant structured context, evaluates many atomic questions in one request, and composes the answers with explicit confidence gates." The step "Route on uncertainty" says: "Make code take different actions for confident and unconfident answers. Escalate uncertain cases to a person or a more expensive reasoning model. Test thresholds by plotting confidence against accuracy on your data." — [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), headings "Design a System One workflow" (steps "Use code when you can", "Combine question outputs in code", "Route on uncertainty") and "Putting it all together".

Practice: sit the call in front of the expensive handler, and let code invoke that handler. Sentence: "TypeSafe can sit in front of all of these as a fast, cheap classifier that determines which handler to invoke." Later: "TypeSafe handles the classification all in a single quick call; the expensive resources only get invoked for the requests that actually need them." The diagram labels the confidence check "your code". `route_ticket` reads `response.answers["intent"]` and `response.answers["complexity"]`, then calls `route_to_human_agent`, `handle_order_status`, or `handle_with_llm`. — [Intent routing](https://docs.typesafe.ai/patterns/intent-routing.md), headings "Intent routing" and "Step 2: route to the optimal handler".

Practice: for closed-set tools, JEV names the function and the arguments; host code makes the call. Sentence: "Turns natural-language trading requests into calls to ordinary typed functions by mapping function names and closed-set arguments to confidence-aware TypeSafe questions." Setup: "`dispatch.py` holds the code that reads a signature and a spec and makes the call." Later: "Each command is then one request carrying the choice of function and every function's arguments, and the dispatcher reads only the chosen function's answers." The host then runs the function: `CALLS[command].run()`. "You leave the functions alone." Open arguments (`int`, free text, numbers, dates) get no question and keep the function default. — [Function calling](https://docs.typesafe.ai/cookbooks/function_calling.md), headings "Function calling", "Setup", "Find the closed sets in the signatures", and "Turn the spec into questions".

Practice: for a skill roster, two JEV requests happen before the agent decides what to load. JEV does not call `skill_view`. Sentence: "Two TypeSafe requests go in front of the decision on which skill to load, if any." The measured agent still has the tool and "keeps its full index and its own judgement". Step 5: "A confident wrong suggestion is more persuasive than no suggestion at all, which is the price of putting one in front of the turn." — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), opening section, the diagram, and "Step 5: measure the suggestion".

Practice: screen both sides of an LLM call, and keep the pass/review/block/support decision in application code. Sentences: "Run this TypeSafe check both on LLM inputs, and on LLM outputs, because even ordinary-looking prompts can lead to harmful generated replies." "By the end you will have a `guard()` function to put on either side of any LLM call." "TypeSafe supplies the assessment; your application owns the decision." — [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails.md), opening section and "Turn the assessment into a decision".

Practice: between retrieval and the answering model, score each passage, then let code decide what reaches that model. Index line: "Score each retrieved passage with one TypeSafe request, then decide in code which ones reach the answering model." Body: "Between retrieval and generation, add a second stage that classifies each retrieved passage." And: "None of the four asks whether to include the passage. That call sits in the code below, where changing it means editing a number instead of rewording a question." — [Classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md), opening section and "Ask four questions about each passage".

Practice: a recorded tool-call trace can be the state of a JEV call, but the call judges the trace; it does not emit the next tool call. The how-to-build page contrasts one broad Noul, "Is `trace.tool_calls` correct for `request` and `available_tools`?", with nine narrow Nouls over an already-filled `trace` (tool name, arguments, schema, date, unit). Those answers are for code to read. The page does not show JEV invoking `geocode_city` or `get_weather`. — [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), step "Decompose the questions", accordion "Example: verify a tool-call trace".

Practice: ask every independent question in one request, before code branches. Sentence: "Ask many narrow, independent questions about the same state in one request." "Questions in the same request are independent: one answer does not become context for another question. If a later judgment depends on an earlier answer, make a second request in code." A second request is allowed only when code cannot build it until it has the first answer. — [Primitives (Questions)](https://docs.typesafe.ai/primitives.md), headings "Ask multiple questions together" and "When one question depends on another". Same rule on the build page: "Decomposition does not require more round trips. Questions over the same state run in parallel." — [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), tip under "Design a System One workflow".

The two published multipliers for that batching disagree, and the cookbook itself was not opened. The primitives page says the parallel-questions cookbook's 13-question batch is "11.5x cheaper and 9.6x faster than 13 separate calls, with no change in the answers." — [Primitives (Questions)](https://docs.typesafe.ai/primitives.md), "Ask speculative questions". The index line for the same cookbook says "12.2x cheaper and 10.0x faster with no change in answers." — [llms.txt](https://docs.typesafe.ai/llms.txt), Parallel questions entry. Do not treat either number as a harness threshold.

### Inferences

- A harness turn loop should call JEV as its own HTTP or SDK request (`client.system_one` / `POST /v1/systemone`), then switch on the typed fields. The docs never show the chat model invoking JEV as one of its tools, and they say JEV itself calls none.
- "In front of the turn" is the documented place for routing, skill suggestion, input guardrails, and passage classification. "On the way out" is documented for output guardrails. Judging a tool trace is documented as a question about a trace the harness already has, not as JEV stepping the loop.
- Who runs the chosen function is the harness after it reads the judgment (function-calling `Dispatcher`, intent-routing `route_ticket`, RAG `route()`, guardrail `route()`). The exception is skill suggestion, where the chat model still calls `skill_view` and may ignore the name JEV picked.

### Gaps

- No opened page says, in those words, "do not register JEV in the tool catalog." The coding-agents page says JEV is not the agent model and does not call tools. Absence of a tool-schema example is not an explicit prohibition.
- The tool-trace example is a decomposition exercise. It does not say a harness must verify every tool call before the next model step.
- [System One](https://docs.typesafe.ai/concepts/system-one.md), [State](https://docs.typesafe.ai/concepts/state.md), [Confidence](https://docs.typesafe.ai/confidence.md), and [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md) were linked but not opened.
- The parallel-questions cookbook was not opened, so the 11.5x/9.6x versus 12.2x/10.0x conflict is unresolved.

## Which primitive does the doc assign to which harness decision?

### Takeaway

Choice is the exclusive route: one option, probabilities that sum to 1, and code may also read the rest of the distribution. Several things that may all apply are separate Nouls, one per candidate, because those answers do not compete. A graded position on a rubric the harness writes is a Score. Ranking passages by "how likely is this the one?" is a Noul sorted by the harness, not a Score, and the rerank cookbook is explicit that the number is P(yes), not a degree.

### Cited Findings

Practice: pick the primitive by the shape of the answer code will branch on. Sentences, under "Choose a question type": "**Choice** fits when the answer is one of a known set of options with no order between them: routing a ticket to a department, classifying a document type, detecting a programming language." "**Score** fits when the answer falls on a spectrum and you can describe what each point on that spectrum means: bug severity, customer frustration, skill level." "**Noul** fits a clean yes/no question where the probability itself is the useful signal." Then: "If two types both seem to fit, prefer the one whose answer your code can act on directly. A Choice between `refund`, `rebook`, and `information` maps straight onto three code paths. A Score of customer frustration maps onto a threshold. A Noul maps onto an `if`." The table: Choice returns `choice`, `probabilities`, `confidence` and "`choice` is the selected option"; Score returns a `score` that "can fall between two of them"; Noul returns "`noul` (0 to 1)", "The probability that the answer is yes." — [Primitives (Questions)](https://docs.typesafe.ai/primitives.md), headings "Primitives (Questions)", "Choose a question type", and "What comes back".

Practice: do not use a Noul as a stand-in for a medium rank. Sentence: "Use Noul for a yes/no judgment and Score to measure a position on a spectrum. "Is this candidate strong in Python?" needs a clear definition of "strong". A Noul value of 0.5 means the model gives yes and no equal probability. It does not mean the candidate has a medium skill level." — [Primitives (Questions)](https://docs.typesafe.ai/primitives.md), note under "Choose a question type". The Noul page repeats it: "A Noul value runs from 0 to 1, but it's not a scale of the thing you asked about. It is the probability that the answer is yes. If the question is really about degree, the value does not measure the degree." — [Noul](https://docs.typesafe.ai/primitives/noul.md), heading "Reading a Noul".

One exclusive route is a Choice.

- "Use a Choice when the answer is one of a fixed set of options." "`choice`: The option with the highest probability." "`probabilities`: The full probability distribution across every option. The sum of all values is 1." A Choice accepts up to 255 options. "Add an `other` or `none of the above` option when the list might not cover every input." — [Choice](https://docs.typesafe.ai/primitives/choice.md), headings "Choice", "Response structure", and "Good practice: ask more than one question per call".
- Intent routing uses one Choice named `intent` whose options are the handlers (`order_status`, `product_question`, `return_exchange`, `complaint`). Code switches on `intent.choice`. A separate Score, `complexity`, is not the route; it only decides whether a complaint goes to a person. — [Intent routing](https://docs.typesafe.ai/patterns/intent-routing.md), "Step 1" and "Step 2".
- Confidence-gated routing uses one Choice, `intent`, with `check_balance`, `approve_transfer`, and `other`. Code then applies different confidence floors per option. The page's own numbers, for this voice-banking example only: below 0.6 go to a person; `check_balance` acts at 0.6; `approve_transfer` auto-acts only above 0.85 and otherwise asks the user to confirm. Sentence: "Above that floor, each action type has its own threshold based on the consequences of acting on a wrong classification." — [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md), "Step 2: confidence-gated routing".
- Function calling picks the function with one Choice, question id `__tool__`, instructions "What is the user asking the trading assistant to do?" A single-value argument is also a Choice "over exactly those values, so whatever reaches the function is a value the function accepts." — [Function calling](https://docs.typesafe.ai/cookbooks/function_calling.md), "Find the closed sets" and "Turn the spec into questions".
- Skill suggestion's second request says: "Exactly one of these skills is the right one to load for the user's latest request. Which one?" That is a Choice. The first request's Choice over all 182 names is also exclusive; "Its probabilities are the ranking," and only the top three are carried forward. — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), "Step 3: rank the whole roster" and "Step 4: rerank the top three".
- The build page's ticket workflow uses Choice `topic` for the team, then `if answers["topic"].choice == "billing"` and the orders and account branches. One topic is selected. — [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), "Putting it all together".
- Score page, the other direction: "If there is no in-between at all, and the answer is one of a few discrete categories, use a Choice instead, or split the question into several Noul questions." — [Score](https://docs.typesafe.ai/primitives/score.md), "Writing good levels".

A Choice is still one winner when code notifies a runner-up. The support example assigns the ticket to `department.choice` and, separately, "A second team with a real share of the probability gets a copy" when `probability > 0.25`. That 0.25 is example code, not a primitive that returns several choices. The response still has one `choice` field. — [Choice](https://docs.typesafe.ai/primitives/choice.md), "A more complex example".

Several tools or passages that may all apply are independent Nouls, not one Choice.

- Function calling sorts arguments into "a **choice** (a `Literal`, so one value out of the list), a **set** (a `list[Literal[...]]`, so any number of them), or a **flag** (a `bool`, so on or off)." "A set argument gets its question once per member." The printed question is a Noul: `compare_returns.symbols.NVDA`, "Does the user want NVDA in the comparison?" The worked call includes three tickers and leaves three out. An optional argument is a second Noul (`stated`): "When the answer is no, the call leaves that argument out and the function's own default applies." — [Function calling](https://docs.typesafe.ai/cookbooks/function_calling.md), "Find the closed sets in the signatures" and "Write the spec".
- Skill suggestion states the split directly. Each shortlisted skill gets its own Noul, "Does the skill '{name}' do the specific thing the user's request asks for?", and "Each is answered on its own, so they can all come back low." "The Choice settles *which* skill, and the nouls settle *whether* to say anything at all." On the deck example the two disagree: the Nouls score `powerpoint` higher (0.73 vs 0.38) while the Choice picks `pptx-author`. The recipe follows the Choice for the name and the Nouls for whether to speak. Those 0.30 cutoffs (`GATE_THRESHOLD`, `FITS_THRESHOLD`) are constants in this cookbook, not a documented harness default. — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), "Step 3" and "Step 4".
- RAG asks four Nouls per passage (`is_relevant`, `contains_answer_evidence`, `contradicts_query_premise`, `contains_prompt_injection`). Several passages can be included on one query. The page says the questions do not decide inclusion. On "How long should an access token live?" four of twelve passages are included. — [Classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md), "Ask four questions about each passage" and "Route each passage in code".
- Guardrails use one Noul per hazard, all free to fire, plus one Score for severity. `route()` in the application maps probabilities to pass, review, block, or support. Policies in this cookbook only: strict action threshold 0.70, permissive 0.85, review 0.35, severity block at score 2.0. "The probabilities do not move; the application decides how much evidence it wants before it acts." — [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails.md), "Define the guardrails" and "The same probabilities, different decisions".
- Noul page: "Ask one yes/no question per Noul. If a question has two conditions, such as "Is the customer angry and asking for a refund?", the model has to judge both at once and the value means less. Ask two Nouls and combine them in code." "Most often your code thresholds `noul` into a boolean." "Where to set the threshold depends on the cost of being wrong." The sample constants `YES = 0.8` and `NO = 0.2` are in that example. — [Noul](https://docs.typesafe.ai/primitives/noul.md), "Writing a Noul question" and "Handling multiple Noul answers in code".
- Independence is the reason they can all apply: "Every answer is independent. One question's answer is not hidden context for another." "The model returns a probability distribution over your options or levels, never a value outside them. Your code never has to recover a value from generated prose." — [Primitives (Questions)](https://docs.typesafe.ai/primitives.md), "What comes back".

A graded rank splits in two, and the docs do not treat them as the same primitive.

- Position on a rubric is a Score. "Use a Score when the answer is a position on a spectrum you can describe in steps." "`score` is a position on the level number line... it can land between two levels." "You can use it to rank reports by severity, or round it to the nearest level when your code needs one outcome." Levels are an ordered array of at least 2 and at most 10. "Describe situations, not degrees." "Keep each Score question to one dimension." Combine several Scores in code with weights the harness owns. — [Score](https://docs.typesafe.ai/primitives/score.md), headings "Score", "Levels", "Reading a Score", "Writing good levels", and "Splitting a complex judgment into several Score questions".
- Intent routing's graded half is that Score: instructions "How complex is this request to resolve", three ordered levels, and code checks `complexity.score > 1`. — [Intent routing](https://docs.typesafe.ai/patterns/intent-routing.md), "Step 1" and the `route_ticket` snippet. The comment in the snippet: "A higher complexity.score leans toward the "escalation needed" end of the scale."
- Ranking many candidates by whether each is the cited passage is a Noul, sorted by the caller. "A plain yes or no would not be enough to rank 30 candidates. A `Noul` instead returns a number between 0 and 1... That noul is the score the application sorts on. No scoring scale has to be invented." Diagram label: "one request per candidate · no request sees another." Pseudocode sorts with `key=lambda c: nouls[c], reverse=True`. — [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), heading "Re-ranking with TypeSafe".
- Choice probabilities are also a ranking, but only among options that sum to 1. Skill suggestion: "Its probabilities are the ranking." One Choice "holds a roster this size comfortably" (182 skills). "A few times larger and you would split it into chunks and rank each one, then run this same shortlist step over the winners." — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), "Step 3: rank the whole roster".

Catalog size from the models page, relevant when a Choice's criteria are the whole tool list: "Context length | 64k tokens per request; 32k tokens for `state` plus the longest question." "Jev ingests the `state` once and evaluates every question against it in parallel. The 64k budget covers the `state` plus all questions combined; the 32k budget applies to the `state` plus the single longest question." — [Models](https://docs.typesafe.ai/models.md), "Current models".

Accuracy figures, kept on their cookbooks:

- Re-ranking, `jev-1.12`, 40 CLERC queries, BM25 shortlist of 30 out of 3,565 passages, gold already in the shortlist for 40/40. Fast search alone versus fast search plus this Noul: top 1 is 5% to 18%, top 5 is 15% to 35%, top 10 is 38% to 62%. 1,200 calls, 1,536,002 input tokens and 25,200 output tokens, cost stated as $0.0645 at the cookbook's jev-1.12 price of $0.042 per million input tokens and $0 output. — [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), "A re-ranking example" and "Re-ranking moves the right answer toward the top". The index blurb matches top-1 and top-10 only. — [llms.txt](https://docs.typesafe.ai/llms.txt).
- Skill suggestion, `jev-1.12` and `claude-haiku-4-5-20251001`, rendered 2026-07-31, 488 requests (315 covered, 173 covered by nothing), 182 Hermes skills. Agent alone: wrong loads 16.8%, needless loads 9.8%. With the suggestion: 7.3% and 4.0%. Handed the right name: 2.5% and 1.2%. "baseline -> TypeSafe: 2.3x fewer wrong loads, 2.4x fewer needless ones." "of 315 covered requests: 37 the suggestion fixed, 7 it broke." — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), opening table and "Step 5: measure the suggestion".

### Inferences

- Exclusive handler, exclusive tool, or "at most one skill": one Choice. Read `choice` for the branch and `confidence` or `probabilities` for whether to act, escalate, or also notify a runner-up.
- A list argument, a set of passages, or a set of hazards that can all be true: one Noul each, then a boolean or a label in code. Do not put those candidates into one Choice if more than one may apply, because a Choice's probabilities sum to 1 and `choice` is a single winner.
- "How severe, how frustrated, how complex": Score, then a threshold or a weighted sum in code. "Which of these passages is the cited one, scored independently": Noul, then sort. Using a Noul's 0.5 as "medium" contradicts the primitives page.

### Gaps

- No opened page uses the phrase "several tools that may all apply." The assignment is answered by the function-calling set-versus-choice split, the skill-suggestion "Choice settles which / nouls settle whether" sentence, and the RAG include-many-passages recipe.
- No page gives a universal mapping table whose rows are "exclusive route / multi-tool / graded rank." The mapping above is the pages' own distinctions, not a single table.
- Composite scoring and the entity-alignment cookbook are cited by these pages as the place a Score is rounded to a level. Those pages were not opened, so the rounding recipe is not quoted here.

## What model id do the current cookbooks pin?

### Takeaway

Every cookbook opened for this note hardcodes `jev-1.12`. The models page's current release, as fetched with these pages, is `jev-1.13.0`, and `jev-latest` points at that. Primitive examples send `jev-latest` and show responses labeled `jev-1.13.0`. The cookbooks have not been updated to that id.

### Cited Findings

- Function calling: `TYPESAFE_MODEL = "jev-1.12"`. The playground link is built with `models=[TYPESAFE_MODEL]`. — [Function calling](https://docs.typesafe.ai/cookbooks/function_calling.md), "Setup".
- Re-ranking: `TYPESAFE_MODEL = "jev-1.12"` and the price comment "TypeSafe jev-1.12 as of 2026-08". — [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), "Setup".
- Skill suggestion: `TYPESAFE_MODEL = "jev-1.12"`. "The published run used `jev-1.12` and `claude-haiku-4-5-20251001`, rendered 2026-07-31." — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), "Caching results".
- Guardrails: `TYPESAFE_MODEL = "jev-1.12"`. "Numbers below came from `jev-1.12` on 2026-08-15." — [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails.md), "Setup".
- Classifying RAG passages: `TYPESAFE_MODEL = "jev-1.12"`. "The numbers here came out of `jev-1.12` and `claude-sonnet-5` on 2026-08-27." — [Classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md), "Setup".

Current models page, same fetch: the only row under "Current models" is "Jev 1.13 | `jev-1.13.0`". Price "$42 / $0.042" per billion / per million input tokens. Output tokens are free. Aliases: "`jev-latest` | `jev-1.13.0` | The most recent stable, official release. The default in our client SDKs, and the name the examples in these docs use." "`jev-preview` | `jev-1.13.0`". "An alias moves when a new release ships, so the answers behind it can change without a change on your side. The response's `model` field reports the versioned ID that answered... If you have tuned confidence thresholds against a specific version, pin that version's ID instead of the alias and move to the new one on your own schedule." "`GET /v1/models` returns the names your account can send... It currently lists the aliases. Versioned IDs such as `jev-1.13.0` are accepted by the `model` field whether or not they appear in the list." — [Models](https://docs.typesafe.ai/models.md), headings "Current models", "Aliases", and "Listing models".

Primitive pages match the alias story, not the cookbook pin. Choice, Score, and Noul request samples set `selectedModels: ['jev-latest']`. Their printed responses say `"model": "jev-1.13.0"`. Noul SDK snippets pass `model="jev-latest"`. The Choice page's five-question sample and the Score page's split-judgment sample both return `jev-1.13.0`. — [Choice](https://docs.typesafe.ai/primitives/choice.md), "Request structure" and "Response structure"; [Score](https://docs.typesafe.ai/primitives/score.md), "Request structure" and "Splitting a complex judgment into several Score questions"; [Noul](https://docs.typesafe.ai/primitives/noul.md), "Request structure" and "Response structure".

The build page's embedded requests also send `selectedModels: ['jev-latest']`. Its `triage_ticket` snippet calls `client.system_one` without a `model` argument. — [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), the request examples and "Putting it all together".

The rerank cookbook's stated jev-1.12 input price, $0.042 per million tokens, matches the models page's current per-million input price for `jev-1.13.0`. That is a price match only. The model ids differ. — [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), "Setup"; [Models](https://docs.typesafe.ai/models.md), "Current models".

### Inferences

- A harness that copies a cookbook and wants those cached numbers reproduces `jev-1.12`. A harness that follows the models page and the primitive examples sends `jev-latest` or pins `jev-1.13.0`, and should expect the response `model` field to say which version answered.
- The models page tells a harness that has tuned thresholds to pin the versioned id. The cookbooks did that for `jev-1.12`. Nothing opened says those `jev-1.12` thresholds transfer to `jev-1.13.0`.

### Gaps

- Not every cookbook in [llms.txt](https://docs.typesafe.ai/llms.txt) was opened. The pin `jev-1.12` is confirmed for function calling, re-ranking, skill suggestion, LLM guardrails, and RAG classification only.
- The models page does not say whether `jev-1.12` is still served. It says versioned ids are accepted even when absent from `GET /v1/models`, but the only versioned id it names is `jev-1.13.0`.
- No cookbook opened here pins `jev-1.13.0` or `jev-latest`.

## Does any page tell a harness to put JEV's answer back into the chat context as prose?

### Takeaway

The standing rule is that code consumes the typed answer and does not ask anyone to parse prose. One cookbook breaks that for a measured reason: skill suggestion writes the winning skill name into the agent's system prompt as a sentence, tells the agent it may ignore it, and reports that this also breaks some turns the agent had right. No other opened page puts the Choice, Score, or Noul itself back into the chat context as prose.

### Cited Findings

The standing rule, quoted.

- "Decisions and probabilities conform to the structured software types and JSON schema your code expects, so it never has to recover a value from generated prose." — [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), "What makes System One composable", card "Structured".
- "Your code never has to recover a value from generated prose." — [Primitives (Questions)](https://docs.typesafe.ai/primitives.md), "What comes back".
- "You compose the answers in your code to make decisions." — [Primitives (Questions)](https://docs.typesafe.ai/primitives.md), opening section.
- "returns structured answers your code can use directly" — [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md), "Jev is not a chat or code-completion LLM".
- Answers may be "put into the state of a follow-up request". That follow-up is another TypeSafe request, and only when code needed the first answer to build it. It is not a chat message. — [Primitives (Questions)](https://docs.typesafe.ai/primitives.md), "What comes back" and "When one question depends on another".
- "Combine independent answers with deterministic rules or weighted sums." — [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md), step "Combine question outputs in code (or feed into a classical ML model)".

What the other recipes do with the answer, none of which is "tell the chat model the judgment in a sentence":

- Function calling: the dispatcher reads `choice` and argument values and calls the Python function. Text the user sees comes from `call.run()`, the trading function, not from JEV. — [Function calling](https://docs.typesafe.ai/cookbooks/function_calling.md), "Run fourteen commands".
- Intent routing and confidence-gated routing: `if` and `elif` on `choice`, `confidence`, and `score`, then a handler. — [Intent routing](https://docs.typesafe.ai/patterns/intent-routing.md); [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md).
- Guardrails: `route()` returns the string `pass`, `review`, `block`, or `support`. The page does not append the nouls or the severity score to the LLM prompt. — [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails.md), "Turn the assessment into a decision".
- RAG: code labels each passage, then the generator prompt contains the passage text in "Accepted evidence" and "Conflicting evidence" blocks. The noul values are not written into that prompt. "Two blocks let the answer push back." The injection warning is about the passages, not about JEV's answer: "A passage that scores under the threshold still reaches the prompt, so the generator prompt has to treat every passage as untrusted text regardless of its score. Nothing here is a security boundary." — [Classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md), "Route each passage in code" and "Build the prompt from the accepted evidence".
- Re-ranking: the harness sorts by `noul`. No chat context is built. — [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), "Re-ranking with TypeSafe".

The exception is the skill-suggestion cookbook. It tells the harness to paste prose into the system prompt.

Opening: "The winner's name goes into one extra line of the agent's system prompt for that turn." The block it prints:

```
<skill_relevance>
Relevant to the current request: pptx-author. Ignore this if it does not fit what the user
actually asked for.
</skill_relevance>
```

"The agent keeps its full index and its own judgement, and that one line only tells it which entry to look at first." `suggestion_block` appends either "Relevant to the current request: {names}. Ignore this if it does not fit what the user actually asked for." or "No skill in the roster appears relevant to this request." The docstring says the string "is a measured input rather than prose: it goes to the agent, so it is part of every graded turn's cache key." That is a warning not to edit the wording, not a claim that the agent receives typed fields. The agent receives the sentence. — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), opening section and "Step 4: rerank the top three".

Why the sentence is worded as advice the model may ignore: "The wording of that suggestion is doing two jobs. It says the suggestion can be ignored, because pushing harder wins compliance on wrong suggestions too, and a wrong one is worse than none. And a turn with nothing to suggest still sends a sentence saying so; sending nothing at all would leave the roster's own "err on the side of loading" instruction unopposed." The measured cost, this cookbook only: "of 315 covered requests: 37 the suggestion fixed, 7 it broke." "A confident wrong suggestion is more persuasive than no suggestion at all, which is the price of putting one in front of the turn." — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), "Step 5: measure the suggestion".

The same page's closing advice for a harness with a large roster is the two-request shape, not the prose injection by itself: "Copy this shape when an agent of yours carries a large roster: a cheap ranking over everything, then a close look at two or three. Either step may come back empty-handed." — [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md), "What the results show".

### Inferences

- Default for a harness: branch, call, filter, or refuse from `choice`, `probabilities`, `confidence`, `score`, and `noul`. Do not serialize those fields into the chat transcript for the model to reinterpret.
- The documented reason to write a sentence anyway is a large skill index the chat model still has to act on, with the sentence marked ignorable, placed after the cached roster, and measured against the model's own selection. The same page records that the sentence overturns correct loads (7 of 315 covered requests in that run).
- Feeding an answer into a later TypeSafe `state` is allowed by the primitives page. That is a second judgment call, not chat prose.

### Gaps

- Cookbooks other than the five named above were not opened, so another page may also inject a sentence. The index blurbs for line-by-line search, citation check, and the smart-home demo do not say they do. Those pages were not fetched.
- The skill-suggestion docstring calls the block "a measured input rather than prose" while the body calls it "one extra line of the agent's system prompt" and prints a sentence. Both are on the same page. The agent-facing text is the sentence.
