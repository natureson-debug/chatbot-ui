# MP-08D.1 decision-only routing

`core/model-router.js` exports synchronous `classify(request)` and `decide(options)`.
It is not imported by Chat or startup. It performs no IO, inference, discovery,
polling, configuration writes or database operations.

Options: existing `config`, optional `legacy`, `defaultModel: {providerId, model}`,
structured `request: {task?, hasImage?, hasDocuments?, useTools?}`, and `priorities`
mapping each task to ordered `{providerId, model}` pairs. No model-name heuristics.
Image intent takes precedence over documents, then tools, then explicit task/text;
combined input requirements are retained. Coding requires verified text, not a
claim that a model has a measured programming specialization.

General text evaluates the conversation default first, then text preferences.
Other categories evaluate preferences then the default. No unlisted model is chosen.
Fallback means a preceding candidate was rejected; it does not imply an inference
retry. The decision contains requestedTask, requiredCapabilities, selected,
conversationDefault, fallbackUsed, eligibility, reason and sanitized candidate reasons.
The caller's default and registry remain unchanged.

Trusted server callbacks (never accept these decisions from browser JSON):

- `authorize(pair, resolvedConnection)` must explicitly allow the user, adapter
  feature gates, global switches, credentials and request restrictions. Defaults deny.
- `availability(pair, resolvedConnection)` must supply matching identity,
  `state: 'available'`, and checkedAt less than 30 seconds old. Defaults unavailable.
- `costPolicy(pair, resolvedConnection)` returns `free`, `paid` or `unknown`.
  Anything except explicitly free requires `approvePaid(...) === true`. Known cloud
  adapters always require approval. Never infer free service from an adapter or URL.
- `documentPipeline(pair, resolvedConnection)` explicitly attests an available
  application extraction pipeline; default false. Native vision is not extraction.
- `capabilities(baseConnection, model)` defaults to the existing MP-08A cache;
  synthetic evidence can be injected in tests. Profiles must match provider/model,
  be less than five minutes old, and verify each mandatory capability in its scope.

Registry resolution preserves enabled/approved model checks and existing provider
gates. Stale, unknown and unsupported evidence are separately rejected. Only the
current Ollama image path qualifies; image-plus-tools remains unqualified. Tool
routing additionally requires the existing configured tool flag and compatible
adapter. Decisions are not authorization tokens: eventual integration must recheck
all permissions, freshness and provider state immediately before inference.

Example: coding preferences `[pairB, pairC]`, with B unavailable and C eligible,
returns selected C, fallbackUsed true, reason `first-eligible-preference`.
An image with only stale vision evidence returns selected null and candidate reason
`capabilities-stale-or-missing`. No provider call is made in either case.

No production integration, settings schema or capability persistence is added.
Live availability acquisition and request-context wiring remain future work.
