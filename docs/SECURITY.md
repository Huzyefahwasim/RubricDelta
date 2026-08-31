# Security and Data Policy

## Intended use and deployment scope

RubricDelta helps a qualified reviewer find labels that a guideline revision may have invalidated. It does not score workers, make employment decisions, or write corrections to a production labeling platform.

`npm start` binds the demo server to `127.0.0.1` by default. The browser workflow runs the deterministic analyzer. Replay and OpenAI belong to the explicit evaluation CLI path; the browser server does not select them.

## Loopback trust boundary

The server answers only requests whose `Host` header names its own bound loopback authority: `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`. It compares the header against the port reported by the listening socket, so an ephemeral port bound with `port: 0` is enforced exactly as a fixed port is.

The guard in `src/server/host-guard.js` runs before path resolution, routing, static file service, run creation, decision and undo mutation, and CSV or trajectory export. A refused request reaches no handler, creates no run, appends no ledger event, and writes no artifact.

- A `Host` naming any other address or name, including a rebinding hostname such as `rebind.attacker.invalid`, receives `403 FORBIDDEN_HOST`.
- A `Host` whose port differs from the bound port receives `403 FORBIDDEN_HOST`.
- An absent, malformed, or repeated `Host` header receives `400 INVALID_HOST`.
- When a request carries `Origin`, that value must be an `http:` origin on the same bound loopback authority. Any other value, including `null` and a cross-site origin, receives `403 FORBIDDEN_ORIGIN`.
- `X-Forwarded-Host`, `X-Forwarded-For`, `X-Forwarded-Proto`, and `Forwarded` are never read. A spoofed forwarding header cannot grant access to a refused `Host` or withdraw access from an accepted one.

This closes a DNS-rebinding path. Before the guard, a page served from an attacker-controlled domain whose name resolved to `127.0.0.1` shared an origin with the demo server. It could create runs, append approve, reject, escalate, and undo events to the ledger, and read `export.csv` and `trajectory.jsonl`. `tests/server-host-guard.test.js` fails four of its seven tests against the pre-guard transport and passes all seven against the current one.

Because the submitted server is a single-user loopback demo, it accepts no other host. A reviewer who reaches it under a different name, such as a machine hostname or a custom `hosts` alias, must use a loopback name instead.

## Data handling and persistence

- The included benchmark contains 100 synthetic support-ticket records across ten cases.
- Users must limit local scenarios to public, synthetic, anonymized, or approved data.
- The API accepts JSON scenarios. It exposes no upload endpoint and no CSV-import path.
- The server writes full scenario input, analysis, recommendations, decisions, trajectories, and CSV snapshots under the configured artifact root, normally `artifacts/runs/`.
- The application implements no retention period or automatic deletion. A user must remove run artifacts under the applicable data-handling policy.
- The evaluation CLI writes to its requested output directory, so the operator must choose an approved path.

## Bounded JSON input

The local API enforces these bounds before analysis:

- one MiB maximum request body;
- at most 100 records per scenario;
- exact JSON object fields and nonblank strings;
- field-length limits for identifiers, labels, guidelines, records, reviewer attribution, and decision reasons;
- unique record IDs and supported decision values.

The browser renders supplied text through DOM text nodes. Static paths and artifact paths reject traversal, absolute paths, symlinks, alternate streams, and reserved Windows names. Responses include a Content Security Policy and other defensive headers.

## CSV export

RubricDelta creates CSV output only. It does not parse imported CSV.

The exporter reconstructs active decision state from the server-owned append-only ledger. It includes rows whose active decision is `approve` and excludes pending, rejected, escalated, and undone decisions. CSV cells that start with spreadsheet formula characters after leading whitespace receive a neutralizing apostrophe.

## Reviewer identity and authorization limit

The decision API requires a nonblank reviewer string, but it does not authenticate the reviewer or enforce reviewer qualifications. The local server has no user accounts, sessions, roles, or access-control policy.

The ledger proves that a decision event passed through the server gate. It does not prove that a human entered the event, that the named reviewer owns the identity, or that the reviewer has the required qualifications. Deployments beyond the loopback demo need authentication, authorization, audit identity, and transport security.

## Credential and provider handling

- The optional OpenAI evaluation path reads `OPENAI_API_KEY` from the Node process environment after the user selects `--provider openai` and supplies `--model`.
- An environment key alone does not change the deterministic default.
- The adapter sends public scenario content to the OpenAI Responses API with `store: false`; operators must approve that data transfer before a live run.
- The adapter keeps the key out of request content, provider results, errors, trajectories, and generated artifacts.
- The browser never receives provider credentials and stores no key.
- A missing key, provider error, invalid output, or replay mismatch fails the affected path without deterministic substitution.

## Controls covered by tests

- active-approval-only export and append-only undo;
- spreadsheet-formula neutralization in CSV output;
- static and artifact path containment;
- request-size, JSON-shape, field-length, and duplicate-ID validation;
- prompt content inside records that attempts to change agent instructions;
- provider-output schema and citation validation;
- credential redaction in responses, errors, traces, replay fixtures, and persisted run artifacts;
- safe response headers and method handling;
- loopback `Host` and `Origin` allowlisting, covering DNS rebinding, port mismatch, absent, malformed, and repeated headers, cross-site mutation and export, and untrusted forwarding headers.

## Known limits before release

- A security scan or review is verified only for the exact source revision bound by `artifacts/qa/release.json`. If that revision-bound release record is absent, the security-review status is unverified.
- No authentication or reviewer-authorization system exists. The loopback host and origin guard blocks cross-origin and rebound browser access; it is not authentication, and any process on the same host can still send a request carrying a correct loopback `Host`.
- No encryption-at-rest or automated retention control exists for run artifacts.
- The trusted single-user loopback server has no aggregate run or revision quota and performs no automatic in-process eviction. A same-host client can consume local memory and artifact-disk space by creating runs or decisions. Keep the server bound to `127.0.0.1`, restrict same-host access, monitor `artifacts/runs/`, stop it when unused, and remove run artifacts under the applicable retention policy. This is an accepted same-host availability limitation, not evidence of a remote route.
- No endpoint writes approved corrections to an external platform.
- No verified live OpenAI evaluation result exists.

Record security findings in the issue tracker or submission notes. Do not publish credentials, private example data, or unredacted development trajectories.
