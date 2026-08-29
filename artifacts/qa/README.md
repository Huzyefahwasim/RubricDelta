# Release QA Protocol

## Status

Release QA has not run. This directory contains the protocol only. It includes no passing result, screenshot, security verdict, clean-clone record, human review proof, or video evidence.

Earlier development checks do not satisfy this release protocol. Record all items against the final source revision and regenerated evidence.

## Run identity

Before testing, record these values in the release QA result:

- date and timezone;
- full Git commit and clean or dirty state;
- Node.js version, operating system, and architecture;
- browser name and version;
- benchmark ID and hash;
- provider, model, seed, repetition count, and review budget;
- tester identifier that contains no private information.

## Automated release gate

Run each command from a clean checkout and retain its exit code and complete output:

```text
npm test
npm run eval
npm run replay:check
npm run eval:replay
npm run evidence
npm run validate
git diff --check
```

Once structured QA, human, video, and release evidence exists, run `npm run validate:final` as the outer final check; its success is not an input that proves the same run.

Confirm that the default evaluation remains deterministic when `OPENAI_API_KEY` exists in the environment. Confirm that replay identifies itself as replay, consumes the exact fixture, and reports `substituted: false`. A missing key, fixture mismatch, extra replay call, incomplete provider case, or validator error must fail closed.

## Browser workflow

Start the final checkout with `npm start`, then use the browser interface for the complete review flow:

1. Load the one-click benchmark example.
2. Open a Rule Seam and inspect the old rule, new rule, interpretation, citations, and affected-record queue.
3. Enter one owner decision for each action: approve, reject, and escalate.
4. Undo one decision and confirm that the event history remains append-only.
5. Export corrections and confirm that the file contains approved records only.
6. Inspect the baseline and advanced metrics, the accessibility failure case, and a retry trajectory.
7. Download the trajectory and verify that it contains no credential or private record.

Record the run ID, record IDs, decision sequence, exported record IDs, and downloaded artifact hashes. Do not use the generated `hackathon-evidence-generator` checkpoint as proof of human review.

## Accessibility and responsive checks

Test at these CSS viewport sizes:

- `375 x 812`;
- `768 x 1024`;
- `1440 x 900`.

At each size, record screenshots and check:

- no horizontal overflow or hidden decision control;
- one `h1`, working skip link, labeled controls, and semantic landmarks;
- visible keyboard focus and logical focus order;
- A, R, E, J, and K shortcuts outside text-entry controls;
- readable old/new rule differences and status text that does not depend on color;
- `aria-live` updates for decisions and errors;
- accessible data tables for charts;
- reduced-motion behavior with the operating-system preference enabled.

Run the complete workflow with keyboard input only. Record any blocked step as a release failure.

## Security review

Run the Codex Security standard repository scan against the final source. Focus the review on:

- request-size, JSON, and provider-output bounds;
- static and artifact path traversal;
- prompt-injection boundaries and benchmark-gold isolation;
- API-key exposure through errors, traces, responses, and artifacts;
- spreadsheet-formula injection in CSV downloads;
- server-owned human approvals and export authorization;
- safe attachment filenames and response headers.

Record each validated finding, severity, affected file, fix commit, focused test, and verification result. Do not claim a clean scan before this record exists.

## Clean-checkout reproduction

Clone the final repository into a new directory with no generated artifacts or credentials. Follow `docs/REPRODUCTION.md` without extra steps. Record command output, generated artifact hashes, exact metric values, and any documentation correction needed.

The expected deterministic result is baseline `16/20 = 0.80` and advanced `18/20 = 0.90` on 100 synthetic records. A different result blocks release until the team explains and versions the change.

## Video evidence

Record the final demo after all release gates pass. Capture the real 100-record benchmark, human review actions, guarded export, measured comparison, failure mode, removed experiment, and reproduction command. Measure the encoded media duration and keep it at five minutes or less.

Record the video filename, SHA-256 hash, duration, resolution, and whether the submission platform accepted the upload. No video completion claim belongs in the repository until the file and measurement exist.

## Release decision

The participant records the release decision after reviewing all failures and deferred items. The record must name the final commit and state either `approve release` or `block release`, with reasons. Agents must not create this decision on the participant's behalf.
