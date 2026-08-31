# RubricDelta provider evaluation

- Benchmark: rubricdelta-support-guideline-drift-v1
- Provider/model: replay / deterministic-role-capture-v1
- Repetitions: 1
- Replay substitution: false

## Primary metric

- baseline: mean 0.80 (min 0.80, max 0.80)
- advanced: mean 0.90 (min 0.90, max 0.90)

## Secondary diagnostics

- baseline MRR: 1.000000
- baseline structural unsupported-claim rate: 0.050000
- baseline escalation rate: 0.000000 (applicable: false; mechanism: not-applicable)
- advanced MRR: 0.920000
- advanced structural unsupported-claim rate: 0.200000
- advanced escalation rate: 0.100000 (applicable: true; mechanism: verifier-uncertain)

Structural support uses each system's native evidence contract and is not comparable across systems.

## Per-case and resource disclosure

- baseline incomplete cases: none; failed cases: none
- baseline resources: calls=10, attempts=10, input/output/total tokens=0/0/0, provider latency ms=0, runtime ms=null, estimated cost USD=0
  - fraud-overrides-refunds: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - identity-check-login: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - deceased-account-owner: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - perishable-delivery-quality: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - legal-data-deletion: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - security-vulnerability: MRR=1.000000, unsupported=0.500000, escalation=0.000000, status=complete
  - assistive-technology-blocker: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - bank-chargeback-filed: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - multi-customer-outage: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - regulated-text-translation: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
- advanced incomplete cases: none; failed cases: none
- advanced resources: calls=40, attempts=40, input/output/total tokens=0/0/0, provider latency ms=0, runtime ms=null, estimated cost USD=0
  - fraud-overrides-refunds: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - identity-check-login: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - deceased-account-owner: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - perishable-delivery-quality: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - legal-data-deletion: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - security-vulnerability: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - assistive-technology-blocker: MRR=0.200000, unsupported=1.000000, escalation=1.000000, status=complete
  - bank-chargeback-filed: MRR=1.000000, unsupported=1.000000, escalation=0.000000, status=complete
  - multi-customer-outage: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete
  - regulated-text-translation: MRR=1.000000, unsupported=0.000000, escalation=0.000000, status=complete

Every repetition is stored before scoring. Provider failures receive zero credit and are never replaced.
