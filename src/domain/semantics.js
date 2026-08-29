const EQUIVALENCE_GROUPS = Object.freeze([
  Object.freeze(["credential", "secret", "token"]),
  Object.freeze(["unauthorized", "unauthorised", "unrecognized", "unrecognised", "unknown"]),
  Object.freeze(["all", "every", "entire", "multiple"]),
  Object.freeze(["translation", "translate", "translated", "mistranslation", "mistranslated"]),
  Object.freeze(["refund", "refunded", "reverse", "reversed", "reimbursement"]),
  Object.freeze(["stolen", "theft", "thief", "compromised", "compromise"]),
  Object.freeze(["deceased", "died", "dead", "late"]),
  Object.freeze(["filed", "opened", "submitted", "started"]),
  Object.freeze(["price", "amount", "cost"]),
  Object.freeze(["customer", "user", "account-holder"]),
]);

const groupByTerm = new Map();
for (const group of EQUIVALENCE_GROUPS) {
  for (const term of group) groupByTerm.set(term, group);
}

function singularize(term) {
  if (term.length < 4 || /(ss|us|is)$/.test(term)) return term;
  if (term.endsWith("ies") && term.length > 4) return `${term.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.endsWith("s")) return term.slice(0, -1);
  return term;
}

function prepare(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\bnot[ -]+authori[sz]ed\b/g, "unauthorized")
    .replace(/\b(?:do|did) not recogni[sz]e\b/g, "unrecognized")
    .replace(/\bnever authori[sz]ed\b/g, "unauthorized")
    .replace(/[-_/]+/g, " ");
}

export function normalizeSemanticText(value) {
  return (prepare(value).match(/[\p{L}\p{N}]+/gu) ?? []).map((raw, index) => ({
    raw,
    term: singularize(raw),
    index,
  }));
}

function equivalent(left, right) {
  const leftGroup = groupByTerm.get(left);
  return Boolean(leftGroup && leftGroup === groupByTerm.get(right));
}

function phraseAt(recordTerms, phraseTerms, start) {
  return phraseTerms.every((term, offset) => recordTerms[start + offset]?.term === term);
}

function numericPriceEvidence(rawScope, scopeTerm, recordText, recordTerms) {
  const priceContext = /\b(?:price|cost|amount|money|total|charge|charged|currency)s?\b/i;
  const currencyContext = /[$€£¥₹]|\b(?:usd|eur|gbp|pkr|cad|aud|jpy|inr)\b/i;
  if (!groupByTerm.get(scopeTerm)?.includes("price") || !priceContext.test(rawScope)) return null;
  if (!priceContext.test(recordText) && !currencyContext.test(recordText)) return null;
  const numeric = [...new Set(recordTerms.filter(({ raw }) => /^\d+(?:\.\d+)?$/.test(raw)).map(({ raw }) => raw))];
  if (numeric.length < 2) return null;
  return {
    scopeTerm: rawScope,
    recordTerm: numeric.join("→"),
    matchType: "semantic-equivalent",
    explanation: `Money-context scope “${rawScope}” matches distinct currency or price values (${numeric.join(", ")}).`,
  };
}

export function matchSemanticScope(scopeTerms, recordText) {
  const recordTerms = normalizeSemanticText(recordText);
  const used = new Set();
  const evidence = [];

  for (const rawScope of scopeTerms) {
    const phraseTerms = normalizeSemanticText(rawScope).map(({ term }) => term);
    if (phraseTerms.length === 0) continue;

    let exactStart = -1;
    for (let index = 0; index <= recordTerms.length - phraseTerms.length; index += 1) {
      if (phraseAt(recordTerms, phraseTerms, index) && phraseTerms.every((_term, offset) => !used.has(index + offset))) {
        exactStart = index;
        break;
      }
    }
    if (exactStart >= 0) {
      phraseTerms.forEach((_term, offset) => used.add(exactStart + offset));
      evidence.push({
        scopeTerm: rawScope,
        recordTerm: recordTerms.slice(exactStart, exactStart + phraseTerms.length).map(({ raw }) => raw).join(" "),
        matchType: "exact",
        explanation: `Changed-scope phrase “${rawScope}” appears in the record after Unicode and plural normalization.`,
      });
      continue;
    }

    if (phraseTerms.length === 1) {
      const scopeTerm = phraseTerms[0];
      const semanticIndex = recordTerms.findIndex(({ term }, index) => !used.has(index) && equivalent(scopeTerm, term));
      if (semanticIndex >= 0) {
        used.add(semanticIndex);
        const recordTerm = recordTerms[semanticIndex].term;
        evidence.push({
          scopeTerm: rawScope,
          recordTerm,
          matchType: "semantic-equivalent",
          explanation: `Bounded equivalence group links “${rawScope}” with “${recordTerm}”.`,
        });
        continue;
      }
      const numeric = numericPriceEvidence(rawScope, scopeTerm, recordText, recordTerms);
      if (numeric) evidence.push(numeric);
    }
  }
  return evidence;
}

export function semanticTerms(value) {
  return normalizeSemanticText(value).map(({ term }) => term);
}
