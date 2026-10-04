import { expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

// pi#137 / smarty-dev#3535, A13.
it("preserves an own __proto__ store key across write, reload and delete", async () => {
	const sandbox = new CodemodeSandbox({ timeoutMs: 10000 });
	try {
		const written = await sandbox.execute('store("__proto__", { secret: 42 });');
		expect(written.ok).toBe(true);
		if (!written.ok) throw new Error(written.error.message);
		expect(Object.hasOwn(written.storeWrites.set, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(written.storeWrites.set)).toBe(Object.prototype);
		const store = { ...written.storeWrites.set };
		const loaded = await sandbox.execute('return load("__proto__");', { store });
		expect(loaded).toMatchObject({ ok: true, value: { secret: 42 } });
		const deleted = await sandbox.execute('store("__proto__", undefined);', { store });
		expect(deleted).toMatchObject({ ok: true, storeWrites: { set: {}, delete: ["__proto__"] } });
		if (!deleted.ok) throw new Error(deleted.error.message);
		for (const key of deleted.storeWrites.delete) delete store[key];
		expect(await sandbox.execute('return load("__proto__") === undefined;', { store })).toMatchObject({
			ok: true,
			value: true,
		});
	} finally {
		await sandbox.close();
	}
});
