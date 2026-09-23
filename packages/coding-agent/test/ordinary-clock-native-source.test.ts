import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Static source correspondence only. Deliberately no compiler, addon load,
// native syscall, runtime/platform qualification or artifact-pin assertion.
test("original addon exports the read-only exact-ns ABI through its existing init", () => {
	const source = readFileSync(new URL("../native/owner-effects/owner-effects.c", import.meta.url), "utf8");
	const primitive = readFileSync(new URL("../native/owner-effects/owner-clock.h", import.meta.url), "utf8");
	expect(source).toContain('#include "owner-clock.h"');
	expect(source).toContain('{"readClockSample", NULL, read_clock_sample');
	expect(source).toContain('napi_set_named_property(env, exports, "clockAbi", abi)');
	expect(primitive).toContain("clock_gettime(CLOCK_MONOTONIC, &now)");
	expect(primitive).toContain("UINT64_MAX - (uint64_t)now.tv_nsec");
	expect(primitive).toContain("static _Atomic int failed");
	expect(primitive).toContain('stat("/proc/self/ns/time", &after)');
	expect(primitive).toContain("napi_create_int32(env, (int32_t)getpid()");
	expect(primitive).not.toMatch(
		/validate_host\(|activate_owner\(|pthread_create\(|fork\(|execve\(|CLOCK_REALTIME|performance|timeOrigin/,
	);
});
