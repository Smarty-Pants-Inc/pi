/**
 * Stands in for the real worker in host tests: posts the JSON message passed as the script source,
 * or each message of a JSON array, so tests can send the host payloads the real prelude never produces.
 */
import { parentPort, workerData } from "node:worker_threads";

const parsed: unknown = JSON.parse((workerData as { code: string }).code);
// Stay alive like the real worker, which waits for call results until the host terminates it.
parentPort?.on("message", () => {});
for (const message of Array.isArray(parsed) ? parsed : [parsed]) parentPort?.postMessage(message);
