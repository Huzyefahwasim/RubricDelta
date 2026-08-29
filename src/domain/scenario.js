import { validateScenario } from "./validation.js";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function toPublicScenario(testCase) {
  const scenario = {
    id: testCase.id,
    title: testCase.title,
    difficulty: testCase.difficulty,
    changeType: testCase.changeType,
    oldGuideline: structuredClone(testCase.oldGuideline),
    newGuideline: structuredClone(testCase.newGuideline),
    records: testCase.records.map(({ id, text, existingLabel }) => ({ id, text, existingLabel })),
  };
  validateScenario(scenario);
  return deepFreeze(scenario);
}
