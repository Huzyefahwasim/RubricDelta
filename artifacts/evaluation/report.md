# RubricDelta paired evaluation

- Benchmark: `rubricdelta-support-guideline-drift-v1`
- Provider/model: `deterministic` / `none`
- Review budget: 20% (2 records per included case)
- Repetitions: 1 (normalized identically: true)
- Started: 2026-08-29T23:07:19.855Z
- Ended: 2026-08-29T23:07:20.213Z
- Wall-clock artifact run: 356.981 ms

## Primary result

- Baseline: 16/20 = 0.80
- Advanced: 18/20 = 0.90
- Absolute improvement: +0.10; relative improvement: 12.5%

## Every benchmark case

### fraud-overrides-refunds

- Baseline — selected: fraud-03, fraud-05; missed: fraud-08; false positives: fraud-05; recall: 0.50
- Advanced — selected: fraud-08, fraud-03; missed: none; false positives: none; recall: 1.00

### identity-check-login

- Baseline — selected: access-02, access-06; missed: none; false positives: none; recall: 1.00
- Advanced — selected: access-02, access-06; missed: none; false positives: none; recall: 1.00

### deceased-account-owner

- Baseline — selected: estate-02, estate-07; missed: none; false positives: none; recall: 1.00
- Advanced — selected: estate-02, estate-07; missed: none; false positives: none; recall: 1.00

### perishable-delivery-quality

- Baseline — selected: quality-04, quality-02; missed: none; false positives: none; recall: 1.00
- Advanced — selected: quality-04, quality-02; missed: none; false positives: none; recall: 1.00

### legal-data-deletion

- Baseline — selected: privacy-02, privacy-06; missed: none; false positives: none; recall: 1.00
- Advanced — selected: privacy-02, privacy-06; missed: none; false positives: none; recall: 1.00

### security-vulnerability

- Baseline — selected: security-02, security-01; missed: security-04; false positives: security-01; recall: 0.50
- Advanced — selected: security-02, security-04; missed: none; false positives: none; recall: 1.00

### assistive-technology-blocker

- Baseline — selected: a11y-04, a11y-02; missed: none; false positives: none; recall: 1.00
- Advanced — selected: a11y-03, a11y-07; missed: a11y-02, a11y-04; false positives: a11y-03, a11y-07; recall: 0.00

### bank-chargeback-filed

- Baseline — selected: dispute-07, dispute-02; missed: none; false positives: none; recall: 1.00
- Advanced — selected: dispute-02, dispute-07; missed: none; false positives: none; recall: 1.00

### multi-customer-outage

- Baseline — selected: outage-02, outage-03; missed: outage-05; false positives: outage-03; recall: 0.50
- Advanced — selected: outage-02, outage-05; missed: none; false positives: none; recall: 1.00

### regulated-text-translation

- Baseline — selected: locale-02, locale-03; missed: locale-04; false positives: locale-03; recall: 0.50
- Advanced — selected: locale-04, locale-02; missed: none; false positives: none; recall: 1.00

## Hard precedence case

`fraud-overrides-refunds` requires the new high-priority rule to override the older general route.
Baseline selected fraud-03, fraud-05; advanced selected fraud-08, fraud-03.

## Resource disclosure

| System | Runtime | Provider calls | Tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: |
| Baseline | not measured | 0 | 0 | $0 |
| Advanced | not measured | 0 | 0 | $0 |

The wall-clock artifact runtime is truthful execution metadata, not a speed comparison. Per-system runtime remains not measured; the deterministic systems make no provider calls, use no model tokens, and cost $0.

## Raw artifacts

- [Manifest](manifest.json)
- [Baseline raw predictions](baseline-predictions.json)
- [Advanced raw predictions](advanced-predictions.json)
- [Per-case trajectories](trajectories/)
- [Complete machine-readable comparison](comparison.json)
