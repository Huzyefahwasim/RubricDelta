import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServerDataService } from "../composition.js";
import { createRubricDeltaApplication } from "./app.js";

export function createRubricDeltaServer({
  port = 4173,
  host = "127.0.0.1",
  publicRoot = resolve("public"),
  artifactRoot = resolve("artifacts"),
} = {}) {
  return createRubricDeltaApplication({
    host,
    port,
    publicRoot,
    artifactRoot,
    dataService: createServerDataService(),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createRubricDeltaServer({});
  await server.start();
  process.stdout.write(`RubricDelta listening on ${server.address()}\n`);
}
