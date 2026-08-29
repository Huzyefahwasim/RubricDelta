# Reproduction Guide

## Environment

- Operating system: Windows, macOS, or Linux
- Node.js: 24 or newer
- Runtime dependencies: none for the offline path
- Network: not required for benchmark, replay, tests, or interface

Record the exact tested Node and operating-system versions in the final run manifest.

## Clean setup

```bash
git clone <submission-url>
cd rubric-delta
npm test
npm run eval
npm start
```

Open `http://localhost:4173` and load the benchmark example.

## Exact evaluation commands

```bash
npm run eval:baseline
npm run eval:advanced
npm run eval
```

The commands write reports under `artifacts/evaluation/`. The combined command must run both systems against the same benchmark version.

## Optional OpenAI run

Set credentials in the shell rather than committing a file:

```bash
OPENAI_API_KEY=<redacted> npm run eval -- --provider=openai --model=<pinned-model>
```

On PowerShell:

```powershell
$env:OPENAI_API_KEY = "<redacted>"
npm run eval -- --provider=openai --model=<pinned-model>
```

Record the exact model ID and pricing date in the resulting manifest. Do not publish the key.

## Expected outputs

- baseline predictions;
- advanced predictions;
- aggregate metrics;
- complete per-case metrics;
- missed and falsely selected records;
- run manifest;
- JSONL trajectories;
- Markdown summary for judges.

## Reproduction acceptance test

A reviewer should be able to remove `artifacts/`, run the commands above, receive new reports, start the interface, make a human decision, and export only approved corrections.
