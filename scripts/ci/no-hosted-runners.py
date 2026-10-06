#!/usr/bin/env python3
"""Inspect resolved workflow runners, not YAML source text (smarty-dev#3644)."""

import itertools
import re
import sys
from pathlib import Path

import yaml


class BlockScalar(str):
    """Preserve scalar style so folded runner labels remain forbidden."""


class WorkflowLoader(yaml.SafeLoader):
    # Actions uses YAML 1.2 Core Schema (10.3.2), not PyYAML's YAML 1.1
    # resolvers. Start empty so legacy booleans, numbers and timestamps stay
    # strings, without changing SafeLoader for other callers.
    yaml_implicit_resolvers = {}

    def construct_core_int(self, node):
        value = self.construct_scalar(node)
        base = 8 if value.startswith("0o") else 16 if value.startswith("0x") else 10
        number = int(value, base)
        # Actions converts hex with Int32.TryParse(AllowHexSpecifier), which
        # interprets the high bit as a sign and rejects values beyond 32 bits.
        # Fail closed on that range rather than letting Python's unsigned
        # magnitude remove or overwrite a possible runner row (pi#138).
        if base == 16 and number > 0x7fffffff:
            raise ValueError(f"unsupported hexadecimal integer: {value}")
        # Actions converts octal with Convert.ToInt32(..., 8), which also
        # treats the high bit as a sign. Fail closed before matrix filtering
        # can hide a possible runner row (smarty-dev#5550 / pi#138).
        if base == 8 and not 0 <= number <= 0o17777777777:
            raise ValueError(f"unsupported octal integer: {value}")
        return number

    def construct_mapping(self, node, deep=False):
        keys = set()
        for key, _ in node.value:
            if key.tag == "tag:yaml.org,2002:merge" or (key.style is None and key.value == "<<"):
                raise ValueError("unsupported YAML merge key")
            value = self.construct_object(key, deep=deep)
            if value in keys:
                raise ValueError(f"duplicate YAML key: {value}")
            keys.add(value)
        return super().construct_mapping(node, deep=deep)

    def construct_scalar(self, node):
        value = super().construct_scalar(node)
        return BlockScalar(value) if node.style in ("|", ">") else value


WorkflowLoader.add_implicit_resolver(
    "tag:yaml.org,2002:null", re.compile(r"^(?:null|Null|NULL|~|)\Z"), ["n", "N", "~", ""]
)
WorkflowLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool", re.compile(r"^(?:true|True|TRUE|false|False|FALSE)\Z"), list("tTfF")
)
# Integer resolution precedes float resolution: both patterns match decimals.
WorkflowLoader.add_implicit_resolver(
    "tag:yaml.org,2002:int", re.compile(r"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)\Z"), list("-+0123456789")
)
WorkflowLoader.add_constructor("tag:yaml.org,2002:int", WorkflowLoader.construct_core_int)
WorkflowLoader.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(r"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\Z"),
    list("-+0123456789."),
)


def matrix_rows(job):
    strategy = job.get("strategy", {})
    if not isinstance(strategy, dict):
        raise ValueError("unsupported/unresolved strategy")
    if "matrix" not in strategy:
        return [{}]
    matrix = strategy["matrix"]
    if not isinstance(matrix, dict) or not matrix:
        raise ValueError("unsupported/unresolved matrix")
    axes = {key: values for key, values in matrix.items() if key not in ("include", "exclude")}
    size = 1
    for key, values in axes.items():
        if not isinstance(key, str) or not isinstance(values, list) or not values:
            raise ValueError("unsupported/unresolved matrix axis")
        size *= len(values)
    if size > 256:
        raise ValueError("unsupported matrix: more than 256 jobs")
    rows = [dict(zip(axes, values)) for values in itertools.product(*axes.values())] if axes else []
    for field in ("include", "exclude"):
        entries = matrix.get(field, [])
        if not isinstance(entries, list) or any(not isinstance(entry, dict) or not entry for entry in entries):
            raise ValueError(f"unsupported/unresolved matrix {field}")
    rows = [row for row in rows if not any(
        all(key in row and row[key] == value for key, value in excluded.items())
        for excluded in matrix.get("exclude", [])
    )]
    originals = [row.copy() for row in rows]
    extra = []
    for included in matrix.get("include", []):
        matched = False
        for original, row in zip(originals, rows):
            if all(key not in original or original[key] == value for key, value in included.items()):
                row.update(included)
                matched = True
        if not matched:
            extra.append(included)
    rows.extend(extra)
    if not rows or len(rows) > 256:
        raise ValueError("unsupported matrix: no jobs or more than 256 jobs")
    return rows


def runner_labels(selection, row, resolve=True):
    if isinstance(selection, BlockScalar):
        raise ValueError("block-scalar runner value is forbidden")
    if isinstance(selection, str):
        if "${{" in selection or "}}" in selection:
            match = re.fullmatch(r"\$\{\{\s*matrix\.([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*\}\}", selection)
            if not resolve or not match:
                raise ValueError(f"unsupported/unresolved runner selection: {selection}")
            value = row
            for key in match[1].split("."):
                if not isinstance(value, dict) or key not in value:
                    raise ValueError(f"unsupported/unresolved runner selection: {selection}")
                value = value[key]
            return runner_labels(value, row, resolve=False)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", selection):
            raise ValueError(f"unsupported/unresolved runner label: {selection!r}")
        return [selection]
    if isinstance(selection, list) and selection:
        labels = []
        for value in selection:
            if not isinstance(value, str):
                raise ValueError("unsupported/unresolved runner label sequence")
            labels.extend(runner_labels(value, row, resolve))
        return labels
    if isinstance(selection, dict) and selection and set(selection) <= {"group", "labels"}:
        if "group" in selection:
            group = selection["group"]
            if not isinstance(group, str) or not group.strip() or "${{" in group or isinstance(group, BlockScalar):
                raise ValueError("unsupported/unresolved runner group")
        return runner_labels(selection["labels"], row, resolve) if "labels" in selection else []
    raise ValueError("unsupported/unresolved runner selection")


def check(workflow_dir, allowlist):
    allowed = {}
    for number, line in enumerate(allowlist.read_text().splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split()
        if len(fields) != 4 or not re.fullmatch(r"https://github\.com/\S+#issuecomment-\d+", fields[3]):
            raise ValueError(f"{allowlist}:{number}: malformed allowlist entry: {line}")
        key = tuple(fields[:3])
        if key in allowed:
            raise ValueError(f"{allowlist}:{number}: duplicate allowlist entry")
        allowed[key] = 0
    workflows = sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")])
    if not workflows:
        raise ValueError(f"No workflows found in {workflow_dir}")
    failed = False
    for path in workflows:
        try:
            workflow = yaml.load(path.read_text(), Loader=WorkflowLoader)
            if not isinstance(workflow, dict) or not isinstance(workflow.get("jobs"), dict) or not workflow["jobs"]:
                raise ValueError("unsupported/unresolved jobs")
            for job_id, job in workflow["jobs"].items():
                try:
                    if not isinstance(job_id, str) or not isinstance(job, dict) or "runs-on" not in job:
                        raise ValueError("unsupported/unresolved job runner (including reusable workflows)")
                    for row in matrix_rows(job):
                        for label in runner_labels(job["runs-on"], row):
                            if re.fullmatch(r"(?:ubuntu|windows|macos)-[\w.-]+", label, re.IGNORECASE):
                                key = (path.name, job_id, label)
                                if key not in allowed:
                                    raise ValueError(f"unapproved hosted runner: {label}")
                                allowed[key] += 1
                except (ValueError, RecursionError) as error:
                    print(f"{path}:{job_id}: {error}", file=sys.stderr)
                    failed = True
        except (yaml.YAMLError, ValueError, TypeError, RecursionError) as error:
            print(f"{path}: invalid or unsupported workflow: {error}", file=sys.stderr)
            failed = True
    for key, uses in allowed.items():
        if not uses:
            print(f"unused hosted-runner allowlist entry (remove it): {' '.join(key)}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(check(Path(sys.argv[1]), Path(sys.argv[2])))
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
