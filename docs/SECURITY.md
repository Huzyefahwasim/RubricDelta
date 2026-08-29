# Security and Data Policy

## Intended use

RubricDelta helps a qualified reviewer find labels that a guideline revision may have invalidated. It does not score workers, make employment decisions, or modify production data without approval.

## Data policy

- The included benchmark uses synthetic records.
- Users must provide public, synthetic, anonymized, or approved data.
- The server does not need to retain uploaded files after a run.
- Trajectories must redact credentials and personal data.
- Generated artifacts must remain inside the configured artifact directory.

## Credential handling

- Read `OPENAI_API_KEY` on the server.
- Never return the key through an endpoint, log, error, or trajectory.
- Never place keys in browser storage.
- Keep `.env` out of version control.
- Fail with a clear message when the live provider lacks credentials.

## Untrusted input

Treat guideline text, CSV fields, uploaded filenames, provider output, and saved artifacts as untrusted.

- Limit upload size and accepted file types.
- Parse CSV without evaluating formulas or code.
- Prevent path traversal.
- Escape user content in HTML.
- Validate model output against strict schemas.
- Set safe response headers.

## Consequential-action boundary

The analyzer can recommend corrections. The exporter includes only records that a human approved. No endpoint may write back to an external labeling platform during the hackathon submission.

## Threats covered by tests

- unapproved export;
- path traversal in static and artifact paths;
- oversized request bodies;
- malformed CSV and duplicate IDs;
- model output with missing evidence;
- prompt content inside records attempting to change agent instructions;
- secrets appearing in trajectory payloads.

## Reporting

Document security problems in the issue tracker or submission notes. Do not publish real credentials or private example data in a report.
