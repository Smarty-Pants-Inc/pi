import type * as Crypto from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import {
	type OriginalCISelection,
	receiveOriginalCIAuthorization,
} from "../src/core/ordinary-sc085-source/ci-authority.ts";

// Inert process/filesystem/pin ports. Tests original argv/buffer/once behavior,
// not installed helper custody, controller ACKs, physical authority or execution.
const ports = vi.hoisted(() => ({
	exec: vi.fn(),
	close: vi.fn(),
	helperBytes: Buffer.from("synthetic helper pin input"),
}));
vi.mock("node:child_process", () => ({ execFileSync: ports.exec }));
vi.mock("node:fs", () => ({
	constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
	openSync: () => 41,
	closeSync: ports.close,
	readFileSync: () => ports.helperBytes,
	lstatSync: () => ({
		uid: 0,
		mode: 0o444,
		dev: 1,
		ino: 2,
		size: 26,
		nlink: 1,
		mtimeMs: 1,
		ctimeMs: 1,
		isSymbolicLink: () => false,
	}),
	fstatSync: () => ({
		uid: 0,
		mode: 0o444,
		dev: 1,
		ino: 2,
		size: 26,
		nlink: 1,
		mtimeMs: 1,
		ctimeMs: 1,
		isFile: () => true,
	}),
}));
vi.mock("node:crypto", async (original) => {
	const actual = await original<typeof Crypto>();
	return {
		...actual,
		createHash: (...args: Parameters<typeof actual.createHash>) => {
			const hash = actual.createHash(...args);
			const update = hash.update.bind(hash);
			const digest = hash.digest.bind(hash);
			let synthetic = false;
			hash.update = (data: Crypto.BinaryLike, encoding?: Crypto.Encoding) => {
				synthetic ||= data === ports.helperBytes;
				return typeof data === "string" && encoding ? update(data, encoding) : update(data);
			};
			hash.digest = ((encoding?: "hex") =>
				synthetic
					? "fdf74629e6a1da89ab9ba9c84c5824eb9b912ec1c2b668c2eb80e98b4505ae61"
					: encoding
						? digest(encoding)
						: digest()) as typeof hash.digest;
			return hash;
		},
	};
});
const selection: OriginalCISelection = {
	controller: {
		path: `/opt/smarty-ci-candidate/releases/${"b".repeat(64)}/candidate-run.py`,
		sha256: "fdf74629e6a1da89ab9ba9c84c5824eb9b912ec1c2b668c2eb80e98b4505ae61",
	},
	authorizationId: "a".repeat(64),
	releaseSha256: "b".repeat(64),
	expected: {} as OriginalCISelection["expected"],
};
const receiving = { path: "/original/receiving", sha256: "c".repeat(64) };
beforeEach(() => {
	ports.exec.mockReset();
	ports.close.mockReset();
});

test("ordinary continuation retains64KiB and has no initial operand", () => {
	const wrapper = {
		version: 1,
		kind: "original-ci-operational-authorization",
		authorization_id: selection.authorizationId,
		release_sha256: selection.releaseSha256,
		authorization: { release_sha256: selection.releaseSha256 },
	};
	ports.exec.mockReturnValue(Buffer.from(JSON.stringify(wrapper)));
	expect(receiveOriginalCIAuthorization(selection, receiving, "preflight")).toEqual(wrapper);
	expect(ports.exec).toHaveBeenCalledTimes(1);
	expect(ports.exec.mock.calls[0][1]).toEqual([
		"-I",
		"-B",
		selection.controller.path,
		"receive-operational",
		selection.authorizationId,
		"preflight",
		receiving.path,
		receiving.sha256,
	]);
	expect(ports.exec.mock.calls[0][2]).toMatchObject({ timeout: 5000, maxBuffer: 65536, stdio: ["ignore", "pipe", 1] });
	expect(ports.close).toHaveBeenCalledExactlyOnceWith(41);
});

test("initial receiving selects9MiB on same helper; malformed projection refuses without retry", () => {
	ports.exec.mockReturnValue(Buffer.from("{}"));
	expect(() => receiveOriginalCIAuthorization(selection, receiving, "preflight", true)).toThrow("INITIAL_FIELDS");
	expect(ports.exec).toHaveBeenCalledTimes(1);
	expect(ports.exec.mock.calls[0][1]).toEqual([
		"-I",
		"-B",
		selection.controller.path,
		"receive-operational",
		selection.authorizationId,
		"preflight",
		receiving.path,
		receiving.sha256,
		"initial",
	]);
	expect(ports.exec.mock.calls[0][2]).toMatchObject({
		timeout: 5000,
		maxBuffer: 9 * 1024 * 1024,
		stdio: ["ignore", "pipe", 1],
	});
	expect(ports.close).toHaveBeenCalledExactlyOnceWith(41);
});
