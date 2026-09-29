// usage: node tsr.mjs TAG  -- prefixes each stdin line with the UTC receive time and TAG.
import { createInterface } from "node:readline";
const tag = process.argv[2] ?? "";
createInterface({ input: process.stdin }).on("line", l => process.stdout.write(`${new Date().toISOString()} ${tag} ${l}\n`));
