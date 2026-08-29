const SCENARIO_KEYS = new Set(["id", "title", "difficulty", "changeType", "oldGuideline", "newGuideline", "records"]);
const GUIDELINE_KEYS = new Set(["version", "text"]);
const RECORD_KEYS = new Set(["id", "text", "existingLabel"]);
function invalid(message) { throw new Error(`Invalid scenario: ${message}`); }
function checkKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label} has unknown field ${key}`);
}
function nonblank(value) { return typeof value === "string" && value.trim().length > 0; }
export function validateScenario(scenario) {
  checkKeys(scenario, SCENARIO_KEYS, "scenario");
  for (const key of ["id", "title", "difficulty", "changeType"]) if (!nonblank(scenario[key])) invalid(`${key} is required`);
  for (const key of ["oldGuideline", "newGuideline"]) { checkKeys(scenario[key], GUIDELINE_KEYS, key); if (!nonblank(scenario[key].text)) invalid(`${key} text is required`); }
  if (!Array.isArray(scenario.records) || scenario.records.length === 0) invalid("records are required");
  const ids = new Set();
  for (const record of scenario.records) { checkKeys(record, RECORD_KEYS, "record"); for (const key of ["id", "text", "existingLabel"]) if (!nonblank(record[key])) invalid(`record ${key} is required`); if (ids.has(record.id)) invalid(`duplicate record id ${record.id}`); ids.add(record.id); }
  return true;
}
