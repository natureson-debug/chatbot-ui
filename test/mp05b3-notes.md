# MP-05B.3 — authenticated HTTP integration qualification

Baseline: `998e76dbf88ca8bd6408f2bbcde928e950abd062`, branch `feature/mp-05b-openai`.

## Isolation

`node --test test/openai-http-integration.test.js` creates a uniquely named directory under the operator's temporary directory. It copies current application source/assets, creates `data/chatbot.db` with the actual schema initializer, and seeds only a synthetic administrator using the existing password hashing function. It never copies production data. The existing admin HTTP endpoint creates the regular user. Random synthetic passwords and API credentials stay in test memory; credential references alone are persisted in temporary connection JSON.

A separate Node process runs the copied, unchanged `server.js` with `CHATBOT_PORT=4173`, `CHATBOT_HOME=<fixture>/home` and a minimal environment. The listener must be `127.0.0.1:4173`; an occupied port fails startup without touching its owner. The application is restarted only inside this fixture to test SQLite-backed selection/session/history continuity and both gate values.

The child bootstrap replaces DNS resolution and HTTPS socket creation before importing the server. It allows only three `.fixture.invalid` hosts, verifies protected transport's pinned lookup and disabled socket reuse, and provides mock Responses/llama.cpp/Ollama traffic. Global fetch and unintercepted HTTP requests are prohibited in the child. No real OpenAI or local inference backend is contacted. Test control and sanitized observation use parent/child IPC, not extra HTTP routes. No production authentication bypass or injection seam was introduced.

## Evidence

Sixteen HTTP scenarios exercise:

- Administrator login, regular-user creation, provider saving, multiple approved models, friendly labels and a non-first default.
- Anonymous chat and non-admin configuration denial.
- Actual frontend `sendMessage()`/stream parser/persistence functions against real authenticated HTTP and disposable SQLite, with mocked DOM only.
- Exactly-once completed assistant persistence, token usage, authenticated history reload, prior-message continuity and saved selection across application restart.
- Disabled, unknown and removed model rejection before credential lookup or provider transport.
- Incremental text using an IPC release barrier (not timing sleeps), exactly one DONE terminal, no duplicated snapshot text and correct default routing.
- Provider failure before text: safe notice, no assistant row. Cancellation after partial text: upstream abort and one partial assistant save, preserving the existing contract.
- Client reader cancellation and request abort, sanitized rate-limit/model/timeout errors, no retries.
- OpenAI → llama.cpp → Ollama → OpenAI continuity without rewriting prior history.
- Gate disabled: no OpenAI catalog entries, saved selection rejection, zero credential lookups/DNS/provider requests, including default routing.
- Gate enabled but missing synthetic environment credential: safe authentication failure and no outbound transport.
- Secret-free server logs/responses, actual graceful shutdown/database closure, port release and fixture deletion.

Final automated run: **456 tests passed, zero failed** (439 existing tests plus 16 integration scenarios and their enclosing test group). All provider responses are mocked. Test assets and the disposable database are removed; only source fixtures and this report remain in the repository.

## Limits and acceptance status

Real-browser acceptance is **UNVERIFIED**: computer/browser inventory reported the browser access host unavailable and the native desktop pipe unavailable. No DOM mock result is presented as browser validation. Desktop/mobile layout, real selector interaction and live-account/model compatibility still require separate acceptance.

Persistence remains frontend-driven: `/api/chat` itself does not insert messages. Completed responses are saved once by the actual frontend function. A failure with no text produces no assistant record. Existing behavior intentionally saves partial answers on cancellation/interruption, while completion/error notices are not persisted. Consequently, an interrupted partial answer has no durable completion-status flag after reload; this qualification does not claim such a flag exists or that arbitrary clients cannot submit duplicate saves. No schema or production behavior changes were made.

The mock socket implements deterministic provider responses, not real TLS negotiation or internet routing. The separate existing protected-transport suite covers address filtering and DNS pinning. No live API entitlement, billing, real model behavior or cancellation billing guarantees are established.

Before any live trial: obtain explicit approval, verify the chosen model's supported parameters, set a spending bound, provision a credential securely, and enable the gate only in the approved isolated process. Production remains unchanged and disabled by default. Do not deploy as part of this task.

Rollback: revert only this test/documentation commit. No application/database/configuration rollback is necessary because none was modified.
