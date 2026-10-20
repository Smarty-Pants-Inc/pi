#!/usr/bin/env python3
"""Inspect resolved workflow runners, not YAML source text (smarty-dev#3644).

Public repositories require standard GitHub-hosted runner labels. YAML anchors
and aliases remain forbidden so runner selections stay explicit.
"""

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


LABEL = r"[A-Za-z0-9][A-Za-z0-9_.-]*"


def plain_condition(cond):
    # pi#195: COND in `COND && 'A' || 'B'` must have no top-level && or ||,
    # so the expression always yields the non-empty literal A or B.
    if not cond.strip() or "${{" in cond or "}}" in cond:
        return False
    depth, i = 0, 0
    while i < len(cond):
        char = cond[i]
        if char == "'":
            end = i + 1
            while True:
                end = cond.find("'", end)
                if end < 0:
                    return False
                if cond[end + 1 : end + 2] != "'":
                    break
                end += 2
            i = end + 1
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth < 0:
                return False
        elif depth == 0 and cond[i : i + 2] in ("&&", "||"):
            return False
        i += 1
    return depth == 0


def runner_labels(selection, row, groups, resolve=True):
    """Return the selected labels; append any runner group name to groups."""
    if isinstance(selection, BlockScalar):
        raise ValueError("block-scalar runner value is forbidden")
    if isinstance(selection, str):
        if "${{" in selection or "}}" in selection:
            cond = re.fullmatch(rf"\$\{{\{{(.*)&&\s*'({LABEL})'\s*\|\|\s*'({LABEL})'\s*\}}\}}", selection, re.DOTALL)
            if resolve and cond and plain_condition(cond[1]):
                return [cond[2], cond[3]]
            match = re.fullmatch(r"\$\{\{\s*matrix\.([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*\}\}", selection)
            if not resolve or not match:
                raise ValueError(f"unsupported/unresolved runner selection: {selection}")
            value = row
            for key in match[1].split("."):
                if not isinstance(value, dict) or key not in value:
                    raise ValueError(f"unsupported/unresolved runner selection: {selection}")
                value = value[key]
            return runner_labels(value, row, groups, resolve=False)
        if not re.fullmatch(LABEL, selection):
            raise ValueError(f"unsupported/unresolved runner label: {selection!r}")
        return [selection]
    if isinstance(selection, list) and selection:
        labels = []
        for value in selection:
            if not isinstance(value, str):
                raise ValueError("unsupported/unresolved runner label sequence")
            labels.extend(runner_labels(value, row, groups, resolve))
        return labels
    if isinstance(selection, dict) and selection and set(selection) <= {"group", "labels"}:
        if "group" in selection:
            group = selection["group"]
            if not isinstance(group, str) or not group.strip() or "${{" in group or isinstance(group, BlockScalar):
                raise ValueError("unsupported/unresolved runner group")
            groups.append(group)
        return runner_labels(selection["labels"], row, groups, resolve) if "labels" in selection else []
    raise ValueError("unsupported/unresolved runner selection")


def check(workflow_dir):
    # Public repositories use standard hosted images only, with no group or
    # per-job exceptions. Keep matrix resolution and malformed-YAML rejection.
    workflows = sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")])
    if not workflows:
        raise ValueError(f"No workflows found in {workflow_dir}")
    failed = False
    for path in workflows:
        try:
            text = path.read_text()
            for event in yaml.parse(text, Loader=WorkflowLoader):
                if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None) is not None:
                    raise ValueError(
                        f"line {event.start_mark.line + 1}: YAML anchor/alias is not allowed (smarty-dev#1246); write the value literally"
                    )
            workflow = yaml.load(text, Loader=WorkflowLoader)
            if not isinstance(workflow, dict) or not isinstance(workflow.get("jobs"), dict) or not workflow["jobs"]:
                raise ValueError("unsupported/unresolved jobs")
            for job_id, job in workflow["jobs"].items():
                try:
                    if not isinstance(job_id, str) or not isinstance(job, dict) or "runs-on" not in job:
                        raise ValueError("unsupported/unresolved job runner (including reusable workflows)")
                    for row in matrix_rows(job):
                        groups = []
                        for label in runner_labels(job["runs-on"], row, groups):
                            if not re.fullmatch(r"(?:ubuntu-(?:latest|22\.04|24\.04)(?:-arm)?|windows-(?:latest|2022|2025|11-arm)|macos-(?:latest|14|15|15-intel|26|26-intel))", label):
                                raise ValueError(f"not a standard GitHub-hosted runner: {label}")
                        if groups:
                            raise ValueError("runner groups are not standard GitHub-hosted runners")
                except ValueError as error:
                    print(f"{path}:{job_id}: {error}", file=sys.stderr)
                    failed = True
        except (yaml.YAMLError, ValueError, TypeError, RecursionError) as error:
            print(f"{path}: invalid or unsupported workflow: {error}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(check(Path(sys.argv[1])))
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
