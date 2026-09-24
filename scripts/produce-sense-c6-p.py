"""Fixed source2 P projection/producer for the existing disposable Pi job only.

No dispatch, checkout replacement, installation into a live profile or cleanup.
The original job retains partial evidence and owns runner teardown.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import resource
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time

SOURCE = "01d36c33c2007eb6869b17d6a1dc52938a825ba06bbf59f54be427f4748213d0"
LOCK = "b9ab7cb9d02e818ba16dd0874285175f3b2cad117326761de0e2c61f285a5e2b"
ARCHIVE = "292565eef733e100b4e77fb085a6ce5df08825dc3e2173473c9368ffe294f7ec"
ARCHIVE_BYTES = 7577741
FILE_LIMIT = 64 * 1024**2
EVIDENCE_LIMIT = 512 * 1024**2
PACK_LIMIT = 256 * 1024**2
ROOT = Path(__file__).resolve().parent.parent


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def save(path, value):
    with path.open("x") as output:
        json.dump(value, output, indent=2)
        output.write("\n")


def file_record(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode), "regular retained file required")
    with path.open("rb") as body:
        digest = hashlib.file_digest(body, "sha256").hexdigest()
    return {"bytes": info.st_size, "sha256": digest, "mode": stat.S_IMODE(info.st_mode),
            "uid": info.st_uid, "gid": info.st_gid}


def records(root):
    result = {}
    for base, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(base) / name
            key = str(path.relative_to(root))
            if path.is_symlink():
                result[key] = {"symlink": os.readlink(path), "realpath": str(path.resolve(strict=True))}
            elif path.is_file():
                result[key] = file_record(path)
            else:
                require(path.is_dir(), "unsupported installed/output node")
    return result


def project(target):
    """All 1839 raw bodies/modes verified before any projection output."""
    fixture = ROOT / ".ci-fixtures/sense-c6-source2"
    raw = (fixture / "SOURCE.json").read_bytes()
    require(sha(raw) == SOURCE, "source manifest pin")
    rows = json.loads(raw)["files"]
    expected = {row["path"]: row for row in rows}
    require(len(expected) == len(rows) == 1839, "complete source2 roster")
    raw_archive = (fixture / "source.tar.gz").read_bytes()
    require(len(raw_archive) == ARCHIVE_BYTES and sha(raw_archive) == ARCHIVE, "source archive pin")
    bodies = {}
    with tarfile.open(fileobj=io.BytesIO(raw_archive), mode="r:gz") as archive:
        for member in archive:
            name = member.name
            require(name in expected and name not in bodies and str(PurePosixPath(name)) == name
                    and not name.startswith("/") and "\\" not in name
                    and all(part not in ("", ".", "..", ".git", "node_modules") for part in name.split("/")),
                    "unsafe or extra source member")
            row = expected[name]
            require(member.isfile() and not member.sparse and not member.linkname
                    and member.size == row["bytes"] and member.mode == int(row["mode"], 8)
                    and member.mode in (0o644, 0o755), "source member identity")
            body = archive.extractfile(member).read(member.size + 1)
            require(len(body) == row["bytes"] and sha(body) == row["selected"], "source body identity")
            bodies[name] = body
    require(set(bodies) == set(expected), "incomplete source projection")
    target.mkdir(mode=0o700)
    for name, body in bodies.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as output:
            output.write(body)
        path.chmod(int(expected[name]["mode"], 8))
    guard(target, rows)
    return rows


def guard(source, rows):
    for row in rows:
        path = source / row["path"]
        require(not path.is_symlink() and path.is_file() and path.stat().st_mode & 0o777 == int(row["mode"], 8)
                and path.stat().st_size == row["bytes"] and sha(path.read_bytes()) == row["selected"],
                "selected source changed: " + row["path"])
    require(sha((source / "package-lock.json").read_bytes()) == LOCK, "selected npm lock changed")


def quota(evidence):
    require(sum(path.stat().st_size for path in evidence.rglob("*") if path.is_file()) <= EVIDENCE_LIMIT,
            "P evidence quota exceeded; partial output is NOT acceptance")


def phase(name, seconds, argv, source, env, evidence):
    def limits():
        # Explicit per-file output bound, not a whole-tree memory/disk claim.
        resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_LIMIT, FILE_LIMIT))
    started = time.time()
    with (evidence / (name + ".log")).open("xb") as log:
        result = subprocess.run(["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", str(seconds - 5) + "s", *argv],
                                cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT,
                                preexec_fn=limits, umask=0o022)
    record = {"phase": name, "argv": argv, "deadlineSeconds": seconds, "commandTimeoutSeconds": seconds - 5, "killGraceSeconds": 5,
              "started": started, "finished": time.time(), "returncode": result.returncode,
              "signal": -result.returncode if result.returncode < 0 else None,
              "log": file_record(evidence / (name + ".log")),
              "childUmask": "0022", "signalScope": "timeout-wrapper status; inner child signal is not inferred",
              "success": result.returncode == 0 and (evidence / (name + ".log")).stat().st_size < FILE_LIMIT}
    save(evidence / (name + ".json"), record)
    quota(evidence)
    require(record["success"], name + " failed or log exhausted; no retry or fallback")


def tool(path, env, version_args=None):
    real = path.resolve(strict=True)
    record = {"path": str(path), "realpath": str(real), **file_record(real)}
    if version_args is not None:
        result = subprocess.run([str(path), *version_args], env=env, capture_output=True, timeout=30)
        require(len(result.stdout) + len(result.stderr) <= 65536, "tool version output bound")
        record.update(returncode=result.returncode, stdout=result.stdout.decode(), stderr=result.stderr.decode())
        require(result.returncode == 0, "incompatible tool: " + str(path))
    return record


def package_manifest(evidence, source):
    package_rows = []
    packed = {row["name"]: row for row in json.loads((evidence / "pack-results.json").read_text())}
    require(len(packed) == 10, "original pack result roster")
    archives = sorted((evidence / "tarballs").glob("*.tgz"))
    require(len(archives) == 10 and sum(path.stat().st_size for path in archives) <= PACK_LIMIT, "ten-archive quota/roster")
    for path in archives:
        raw = path.read_bytes()
        members = []
        names = set()
        metadata = None
        payload = 0
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
            for member in archive:
                name = member.name
                require(name not in names and name.startswith("package/") and str(PurePosixPath(name)) == name
                        and "\\" not in name and all(part not in ("", ".", "..", ".git", "node_modules") for part in name.split("/"))
                        and member.isfile() and not member.sparse and not member.linkname
                        and member.mode in (0o644, 0o755), "unsafe package member")
                names.add(name)
                payload += member.size
                require(len(names) <= 10000 and 0 <= member.size <= FILE_LIMIT and payload <= PACK_LIMIT,
                        "package member/output quota")
                body = archive.extractfile(member).read(member.size + 1)
                require(len(body) == member.size, "short package body")
                members.append({"path": name, "bytes": len(body), "mode": member.mode, "sha256": sha(body)})
                if name == "package/package.json":
                    metadata = json.loads(body)
        require(metadata and metadata["version"] == "0.85.1", "package metadata")
        original = packed[metadata["name"]]
        require(original["file"] == path.name and original["bytes"] == len(raw) and original["sha256"] == sha(raw),
                "archive rebound from original pack result")
        package_root = (source / original["directory"]).resolve()
        require(package_root.is_relative_to(source), "package source escape")
        for member in members:
            if member["path"].startswith("package/dist/"):
                emitted = package_root / member["path"].removeprefix("package/")
                require(not emitted.is_symlink() and emitted.resolve(strict=True).is_relative_to(package_root)
                        and file_record(emitted)["sha256"] == member["sha256"],
                        "archive body differs from actual emitted graph")
        if metadata["name"] == "@earendil-works/pi-coding-agent":
            require(metadata["exports"]["./ordinary"] == {"types": "./dist/ordinary.d.ts", "import": "./dist/ordinary.js"}
                    and {"package/dist/ordinary.js", "package/dist/ordinary.d.ts"} <= names, "real ordinary entry/declarations")
        package_rows.append({"name": metadata["name"], "file": path.name, "bytes": len(raw), "sha256": sha(raw),
                             "sha512": hashlib.sha512(raw).hexdigest(), "members": members})
    save(evidence / "PI-C6-SOURCE2-MEMBERS.json", {"schema": "sense-pi-c6-source2-members/1",
                                               "sourceSha256": SOURCE, "packages": package_rows})


def main():
    require(len(sys.argv) == 2, "one original private output directory required")
    require(os.environ.get("GITHUB_ACTIONS") == "true" and platform.system() == "Linux"
            and platform.machine() == "x86_64", "existing disposable Linux x64 job required")
    require('VERSION_ID="24.04"' in Path("/etc/os-release").read_text(), "Ubuntu24 required")
    out = Path(sys.argv[1])
    require(out.is_absolute() and out == Path(os.environ["RUNNER_TEMP"]) / "sense-c6-source2-P"
            and out.resolve() == out and not out.exists(), "fresh original P state required")
    out.mkdir(mode=0o700)
    evidence = out / "evidence"
    evidence.mkdir(mode=0o700)
    outcome = {"status": "IN_PROGRESS", "sourceSha256": SOURCE, "phases": "600/300/600/600", "wholeJobCeiling": 7200,
               "cleanup": "original hosted job after retention; NOT native retirement proof"}
    try:
        source = out / "source"
        rows = project(source)
        save(evidence / "projection.json", {"sourceSha256": SOURCE, "sourceArchiveSha256": ARCHIVE, "files": len(rows),
             "npmLock": LOCK, "hostCheckoutNotProjection": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
             "originalJob": {key: os.environ.get(key) for key in ("GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_WORKFLOW_SHA",
                 "GITHUB_WORKFLOW_REF", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "RUNNER_NAME", "RUNNER_OS", "RUNNER_ARCH")}})
        for name in ("home", "tmp", "cache"):
            (out / name).mkdir(mode=0o700)
        for name in ("npm-userconfig", "npm-globalconfig"):
            (out / name).touch(mode=0o600)
        env = {"PATH": os.environ["PATH"], "HOME": str(out / "home"), "USERPROFILE": str(out / "home"),
               "TMPDIR": str(out / "tmp"), "TMP": str(out / "tmp"), "TEMP": str(out / "tmp"),
               "XDG_CONFIG_HOME": str(out / "home/.config"), "XDG_CACHE_HOME": str(out / "cache"),
               "PI_CODING_AGENT_DIR": str(out / "home/.pi/agent"), "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "PI_NO_LOCAL_LLM": "1",
               "AWS_EC2_METADATA_DISABLED": "true", "CI": "true", "GITHUB_ACTIONS": "true", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/usr/bin/false",
               "NPM_CONFIG_USERCONFIG": str(out / "npm-userconfig"), "NPM_CONFIG_GLOBALCONFIG": str(out / "npm-globalconfig"),
               "NPM_CONFIG_CACHE": str(out / "cache/npm"), "npm_config_jobs": "1", "GOMAXPROCS": "2", "NODE_OPTIONS": "--max-old-space-size=4096"}
        node = Path(shutil.which("node", path=env["PATH"]) or "")
        npm = Path(shutil.which("npm", path=env["PATH"]) or "")
        require(node.is_absolute() and npm.is_absolute() and node.parent == npm.parent, "one selected Node/npm tool prefix")
        env["PATH"] = str(node.parent) + ":/usr/bin:/bin"
        tools = {"node": tool(node, env, ["--version"]), "npm": tool(npm, env, ["--version"])}
        require(tools["node"]["stdout"].strip() == "v22.23.2", "exact P Node22.23.2 required")
        save(evidence / "tool-host.json", tools)
        phase("dependencies", 600, [str(npm), "ci", "--ignore-scripts"], source, env, evidence)
        guard(source, rows)
        for name, package in (("tsgo", "@typescript/native-preview"), ("esbuild", "esbuild"), ("shx", "shx")):
            selected_tool = source / "node_modules/.bin" / name
            require(selected_tool.resolve(strict=True).is_relative_to(source / "node_modules"), "foreign installed tool")
            tools[name] = tool(selected_tool, env, None if name == "shx" else ["--version"])
            tools[name]["packageVersion"] = json.loads((source / "node_modules" / package / "package.json").read_text())["version"]
            require(tools[name]["packageVersion"] == json.loads((source / "package.json").read_text())["devDependencies"][package],
                    "installed tool package pin mismatch")
        save(evidence / "installed-tools.json", tools)
        save(evidence / "installed-files.json", records(source / "node_modules"))
        loader = subprocess.run(["/usr/bin/ldd", tools["node"]["realpath"]], capture_output=True, timeout=30)
        (evidence / "node-loader.log").write_bytes(loader.stdout + loader.stderr)
        require(loader.returncode == 0, "node loader observation failed")
        libraries = sorted(set(re.findall(r"(?:=>\s+)?(/\S+)\s+\(", loader.stdout.decode())))
        require(libraries, "node loader paths unavailable")
        save(evidence / "node-loader-files.json", [tool(Path(path), env) for path in libraries])
        quota(evidence)
        phase("public-model-data", 300, ["/usr/bin/bash", "--noprofile", "--norc", "-euo", "pipefail", "-c",
              "npm run hydrate:model-data; npm --prefix packages/ai run check:model-data"], source, env, evidence)
        guard(source, rows)
        data = source / "packages/ai/src/providers/data"
        model_data = records(data)
        require(model_data and all("symlink" not in row for row in model_data.values()),
                "actual hydrated model DATA missing or aliased")
        shutil.copytree(data, evidence / "model-data")
        save(evidence / "model-data-inputs.json", {"basis": "public DATA-only hydration checked against unchanged selected catalog structure",
             "notFrozenPriorValues": True, "sourceSha256": SOURCE, "files": model_data})
        phase("build", 600, [str(npm), "run", "build:offline"], source, env, evidence)
        guard(source, rows)
        require(records(data) == model_data, "hydrated model DATA changed during build")
        phase("package-stage", 600, [str(node), str(ROOT / "scripts/pack-sense-c6-p.mjs"), str(evidence)], source, env, evidence)
        guard(source, rows)
        require(records(data) == model_data, "hydrated model DATA changed during pack")
        package_manifest(evidence, source)
        quota(evidence)
        outcome["status"] = "P_PRODUCED_NOT_RECEIVED_OR_NATIVE_QUALIFIED"
    except BaseException as error:
        outcome.update(status="FAILED", error={"type": type(error).__name__, "message": str(error)})
        raise
    finally:
        save(evidence / "RESULT.json", outcome)


if __name__ == "__main__":
    main()
