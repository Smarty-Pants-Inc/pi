// P packaging process only. Never import this driver into a live Pi session.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

assert(process.version === 'v22.23.2' && process.argv.length === 3, 'P exact Node/argv');
const source = process.cwd(), evidence = resolve(process.argv[2]);
assert(isAbsolute(process.argv[2]) && relative(source, evidence).startsWith('../'), 'P output outside source');
const expected = ['chord', 'pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-client', 'pi-protocol',
  'pi-server', 'pi-session-backend-sqlite-node', 'pi-telemetry', 'pi-tui'].map(name => '@earendil-works/' + name).sort();
const { getPublicWorkspacePackages } = await import(pathToFileURL(join(source, 'scripts/release-packages.mjs')).href);
const packages = getPublicWorkspacePackages();
assert.deepEqual(packages.map(row => row.name).sort(), expected);
assert(packages.every(row => row.version === '0.85.1'), 'P package versions');
const requiredExports = ['receiveOrdinaryOperationalCollector', 'receiveOrdinarySenseComposition',
  'beginOrdinaryExposure', 'commitOrdinaryExposure', 'deliverOrdinaryExposure', 'abortOrdinaryExposure'];
const ts = createRequire(join(source, 'package.json'))('typescript');
const entries = {};
for (const name of ['ordinary.js', 'ordinary.d.ts']) {
  const path = join(source, 'packages/coding-agent/dist', name), bytes = readFileSync(path);
  const parsed = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, 'P emitted entry syntax');
  const exports = parsed.statements.filter(statement => ts.isExportDeclaration(statement) && !statement.isTypeOnly
    && statement.exportClause && ts.isNamedExports(statement.exportClause))
    .flatMap(statement => statement.exportClause.elements.filter(element => !element.isTypeOnly).map(element => element.name.text));
  assert(requiredExports.every(name => exports.includes(name)), 'P actual six named exports');
  entries[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, exports };
}
writeFileSync(join(evidence, 'ordinary-emitted-exports.json'), JSON.stringify({ entries,
  scope: 'parsed emitted export syntax and bytes only; NOT full typecheck, import evaluation or native behavior' }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
const destination = join(evidence, 'tarballs');
mkdirSync(destination, { mode: 0o700 });
let count = 0, archiveBytes = 0;
const original = childProcess.spawnSync;
// ponytail: the maintained helper discards npm's original JSON after parsing.
// Observe that exact call's unmodified result in this disposable pack process;
// do not alter the selected Pi helper, rerun npm pack, or fabricate a JSON record.
childProcess.spawnSync = (command, args, options) => {
  assert.equal(command, 'npm');
  assert.deepEqual(args, ['pack', '--ignore-scripts', '--json', '--pack-destination', destination]);
  assert(count < 10 && options.timeout === 300_000 && options.encoding === 'utf8');
  const ordinal = ++count, result = original(command, args, options);
  for (const key of ['stdout', 'stderr'])
    writeFileSync(join(evidence, `pack-${ordinal}.${key}`), result[key] ?? '', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(evidence, `pack-${ordinal}.process.json`), JSON.stringify({
    command, args, cwd: options.cwd, pid: result.pid, status: result.status, signal: result.signal,
    timeout: options.timeout, stdoutNull: result.stdout === null, stderrNull: result.stderr === null,
    error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : null,
    observation: 'original spawnSync result; helper receives the same result object',
  }) + '\n', { flag: 'wx', mode: 0o600 });
  if (result.status === 0 && !result.error) {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : Object.values(parsed);
    assert(rows.length === 1 && typeof rows[0].filename === 'string');
    const file = rows[0].filename;
    assert(file.endsWith('.tgz') && !file.includes('/') && !file.includes('\\') && file !== '..');
    archiveBytes += statSync(join(destination, file)).size;
    assert(archiveBytes <= 256 * 1024 ** 2, 'P archive cohort quota exceeded');
  }
  return result;
};
syncBuiltinESMExports();
try {
  const { packReleasePackages } = await import(pathToFileURL(join(source, 'scripts/coding-agent-consumer.mjs')).href);
  const tarballs = packReleasePackages(packages, destination);
  assert(count === 10 && tarballs.size === 10);
  writeFileSync(join(evidence, 'pack-results.json'), JSON.stringify([...tarballs].map(([name, path]) => {
    const bytes = readFileSync(path);
    return { name, directory: packages.find(row => row.name === name).directory, file: relative(destination, path), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('hex') };
  }), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} finally {
  childProcess.spawnSync = original;
  syncBuiltinESMExports();
}
// Existing supplier DATA check; no archive mode repair or consumer install.
for (const row of JSON.parse(readFileSync(join(evidence, 'pack-results.json'), 'utf8')))
  childProcess.execFileSync('/usr/bin/python3', ['-I', '-B', join(source, 'scripts/check-package-bin-modes.py'),
    join(destination, row.file)], { stdio: 'inherit', timeout: 30_000 });
