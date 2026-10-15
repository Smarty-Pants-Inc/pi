// pi#267: inspect the actual Node worker's resource limits, not mocked constructor calls.
import { parentPort, resourceLimits, workerData } from "node:worker_threads";

parentPort?.on("message", () => {});
parentPort?.postMessage({
	type: "done",
	ok: true,
	value: JSON.stringify({ resourceLimits, memoryLimitBytes: workerData.memoryLimitBytes }),
	writes: "[]",
});
