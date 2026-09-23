import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { OwnerHost, readOriginalPreparedClockSample, receiveOriginalClockSource } from "../src/core/owner-effects.ts";

// Actual loader ordering, inert FS/module/profile ports. No actual addon, file,
// Host, permission, allocation, native read or syscall is exercised.
const ports = vi.hoisted(() => ({
	files: new Map<number, string>(),
	next: 10,
	load: vi.fn(),
	validate: vi.fn(() => ({})),
	read: vi.fn(),
	close: vi.fn(),
	profile: {
		runtime: {
			architecture: process.arch,
			kind: process.versions.bun ? "bun" : "node",
			version: process.versions.bun ?? process.versions.node,
		},
		artifacts: {
			addon: { path: "/r/addon", sha256: "" },
			runtime: { path: "/r/node", sha256: "" },
			bubblewrap: { path: "/r/bwrap", sha256: "" },
			closure: [],
		},
		host: { cgroup: "/group" },
		storage: { root: "/storage" },
		sandbox: { toolRoot: "/tools", fileRoots: [] },
	},
}));
vi.mock("node:module", () => ({ createRequire: () => Object.assign(ports.load, { cache: {} }) }));
vi.mock("../src/core/owner-profile.ts", () => ({
	OWNER_NATIVE_ABI: 3,
	parseOwnerHostProfile: () => ports.profile,
	ownerProfileDigest: () => "a".repeat(64),
}));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof importNodeFs>();
	const stat = (path: string) => ({
		uid: 0,
		mode: 0o444,
		nlink: 1,
		size: Buffer.byteLength(path),
		dev: 1,
		ino: path === "/r/node" ? 42 : 7,
		mtimeMs: 1,
		ctimeMs: 1,
		isDirectory: () => true,
		isFile: () => true,
	});
	return {
		...fs,
		openSync: (path: string) => {
			const fd = ports.next++;
			ports.files.set(fd, path === "/proc/self/exe" ? "/r/node" : path);
			return fd;
		},
		fstatSync: (fd: number) => stat(ports.files.get(fd)!),
		lstatSync: (path: string) => stat(path),
		readFileSync: (fd: number) => Buffer.from(ports.files.get(fd)!),
		closeSync: ports.close,
	};
});

import type * as importNodeFs from "node:fs";

test("artifact-only preparation precedes Host validation and later Host rejects a different module", () => {
	for (const artifact of [
		ports.profile.artifacts.addon,
		ports.profile.artifacts.runtime,
		ports.profile.artifacts.bubblewrap,
	])
		artifact.sha256 = createHash("sha256").update(artifact.path).digest("hex");
	const native = new Proxy(
		{ abi: 3, clockAbi: 1, readClockSample: ports.read, validateHost: ports.validate },
		{
			has: () => true,
			get: (target, key) => (key in target ? Reflect.get(target, key) : () => {}),
		},
	);
	ports.load.mockReturnValue(native);
	const prepared = receiveOriginalClockSource({ path: "/r/profile", sha256: "a".repeat(64) });
	expect(prepared.implementation).toEqual(ports.profile.artifacts.addon);
	expect(Object.keys(prepared)).toEqual(["implementation"]);
	expect(Object.isFrozen(prepared)).toBe(true);
	expect(ports.validate).not.toHaveBeenCalled();
	expect(ports.read).not.toHaveBeenCalled();
	expect(ports.close).toHaveBeenCalledTimes(5); // profile/addon/runtime/executable/addon recheck
	OwnerHost.loadNative("/r/profile");
	expect(ports.validate).toHaveBeenCalledTimes(1);
	const sample = {
		monotonicNs: "1",
		bootId: "11111111-2222-3333-4444-555555555555",
		timeNamespace: { device: "1", inode: "2" },
		pid: 3,
	};
	ports.read.mockReturnValue(sample);
	expect(readOriginalPreparedClockSample()).toBe(sample);
	expect(ports.read).toHaveBeenCalledTimes(1);
	ports.load.mockReturnValue(new Proxy(native, {}));
	expect(() => OwnerHost.loadNative("/r/profile")).toThrow("CLOCK_HOST_REBOUND");
	expect(ports.validate).toHaveBeenCalledTimes(1);
});
