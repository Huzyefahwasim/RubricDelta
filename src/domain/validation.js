const SCENARIO_KEYS = new Set(["id", "title", "difficulty", "changeType", "oldGuideline", "newGuideline", "records"]);
const GUIDELINE_KEYS = new Set(["version", "text"]);
const RECORD_KEYS = new Set(["id", "text", "existingLabel"]);

function invalid(message) {
  throw new Error(`Invalid scenario: ${message}`);
}

function checkKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label} has unknown field ${key}`);
}

export function validateScenario(scenario) {
  checkKeys(scenario, SCENARIO_KEYS, "scenario");
  for (const key of ["id", "title", "difficulty", "changeType"]) {
    if (typeof scenario[key] !== "string" || scenario[key].length === 0) invalid(`${key} is required`);
  }
  for (const key of ["oldGuideline", "newGuideline"]) {
    checkKeys(scenario[key], GUIDELINE_KEYS, key);
    if (typeof scenario[key].text !== "string" || scenario[key].text.length === 0) invalid(`${key} text is required`);
  }
  if (!Array.isArray(scenario.records) || scenario.records.length === 0) invalid("records are required");
  const ids = new Set();
  for (const record of scenario.records) {
    checkKeys(record, RECORD_KEYS, "record");
    for (const key of ["id", "text", "existingLabel"]) {
      if (typeof record[key] !== "string" || record[key].length === 0) invalid(`record ${key} is required`);
    }
    if (ids.has(record.id)) invalid(`duplicate record id ${record.id}`);
    ids.add(record.id);
  }
  return true;
}
