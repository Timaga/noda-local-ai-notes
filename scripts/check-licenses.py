#!/usr/bin/env python3
"""Check source or staged-runtime license integrity offline, using only stdlib."""

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath

LICENSE_ID = "PolyForm-Noncommercial-1.0.0"
LICENSE_SHA256 = "ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8"
VERSION = "1.0.2-beta.17"
SCHEMA = "noda-license-manifest-v1"
REQUIRED = {"LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"}
KINDS = {"project-license", "required-notice", "third-party-license", "provenance"}


class LicenseCheckError(ValueError):
    """The checked artifact does not satisfy its versioned licensing manifest."""


def require(condition, message):
    if not condition:
        raise LicenseCheckError(message)


def checked_stat(path):
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode), f"Symbolic link rejected: {path.name!r}")
    require(
        not getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024),
        f"Reparse point rejected: {path.name!r}",
    )
    require(
        stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),
        f"Special file rejected: {path.name!r}",
    )
    return info


def safe_path(root, relative):
    require(
        isinstance(relative, str) and relative, "File path must be a nonempty string"
    )
    parts = PurePosixPath(relative).parts
    require(
        not relative.startswith("/")
        and "/".join(parts) == relative
        and all(
            part not in (".", "..") and not part.endswith((".", " ")) for part in parts
        )
        and not any(char in relative for char in "\\:\0")
        and not any(ord(char) < 32 for char in relative),
        f"Unsafe relative path: {relative!r}",
    )
    current = root
    for index, part in enumerate(parts):
        current = current / part
        info = checked_stat(current)
        if index < len(parts) - 1:
            require(
                stat.S_ISDIR(info.st_mode), f"Parent is not a directory: {relative!r}"
            )
    require(
        current.resolve().is_relative_to(root.resolve()),
        f"Path escapes artifact root: {relative!r}",
    )
    return current


def read_file(root, relative):
    path = safe_path(root, relative)
    info = checked_stat(path)
    require(stat.S_ISREG(info.st_mode), f"Expected a regular file: {relative!r}")
    require(
        info.st_size <= 16 * 1024 * 1024,
        f"Legal file is unexpectedly large: {relative!r}",
    )
    return path.read_bytes()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key!r}")
        result[key] = value
    return result


def read_json(root, relative):
    return json.loads(
        read_file(root, relative).decode("utf-8"), object_pairs_hook=unique_object
    )


def license_tree(root, relative="LICENSES", depth=0):
    require(depth < 32, "License directory nesting exceeds the supported limit")
    directory = safe_path(root, relative)
    require(
        stat.S_ISDIR(checked_stat(directory).st_mode), "LICENSES must be a directory"
    )
    result = set()
    for child in directory.iterdir():
        name = relative + "/" + child.name
        info = checked_stat(child)
        if stat.S_ISDIR(info.st_mode):
            result.update(license_tree(root, name, depth + 1))
        else:
            safe_path(root, name)
            result.add(name)
    return result


def check_package_metadata(root):
    package_path = "frontend/package.json"
    lock_path = "frontend/package-lock.json"
    present = [
        (root / path).exists() or (root / path).is_symlink()
        for path in (package_path, lock_path)
    ]
    if not any(present):
        return "not present in runtime-only artifact"
    require(all(present), "Source package metadata is incomplete")
    package = read_json(root, package_path)
    lock = read_json(root, lock_path)
    require(
        isinstance(package, dict) and isinstance(lock, dict),
        "Package metadata must be objects",
    )
    locked_root = lock.get("packages", {}).get("")
    require(isinstance(locked_root, dict), "Lockfile root package is missing")
    for name, item in (("package.json", package), ("lock root", locked_root)):
        require(item.get("name") == "noda", f"Wrong project name in {name}")
        require(item.get("version") == VERSION, f"Wrong project version in {name}")
        require(item.get("license") == LICENSE_ID, f"Wrong project license in {name}")
    require(
        lock.get("name") == "noda" and lock.get("version") == VERSION,
        "Lockfile identity differs",
    )
    return "verified"


def check(root):
    root = Path(os.path.abspath(root))
    require(
        stat.S_ISDIR(checked_stat(root).st_mode), "Artifact root must be a directory"
    )
    manifest = read_json(root, "LICENSES/manifest.json")
    require(isinstance(manifest, dict), "License manifest must be an object")
    require(manifest.get("schema") == SCHEMA, "Unknown license manifest schema")
    require(
        manifest.get("project_license") == LICENSE_ID, "Wrong manifest project license"
    )
    require(
        manifest.get("project_version") == VERSION, "Wrong manifest project version"
    )
    records = manifest.get("files")
    require(
        isinstance(records, list) and 0 < len(records) <= 4096,
        "Invalid manifest file inventory",
    )
    seen = set()
    vendor_count = 0
    for row in records:
        require(isinstance(row, dict), "Invalid manifest file record")
        relative, digest, kind = row.get("path"), row.get("sha256"), row.get("kind")
        require(isinstance(relative, str), "Manifest file path must be a string")
        require(relative not in seen, f"Duplicate manifest file: {relative!r}")
        require(
            relative in REQUIRED or relative.startswith("LICENSES/"),
            f"Unrecognized protected path: {relative!r}",
        )
        require(
            relative != "LICENSES/manifest.json", "Manifest cannot inventory itself"
        )
        require(
            isinstance(digest, str) and re.fullmatch("[0-9a-f]{64}", digest),
            f"Invalid SHA-256: {relative!r}",
        )
        require(kind in KINDS, f"Unknown license file kind: {kind!r}")
        data = read_file(root, relative)
        require(
            hashlib.sha256(data).hexdigest() == digest,
            f"License hash mismatch: {relative!r}",
        )
        if relative == "LICENSE":
            require(
                digest == LICENSE_SHA256 and kind == "project-license",
                "Canonical PolyForm license differs",
            )
        elif relative in REQUIRED:
            require(kind == "required-notice", f"Wrong notice file kind: {relative!r}")
        else:
            require(
                kind in {"third-party-license", "provenance"},
                f"Wrong vendor file kind: {relative!r}",
            )
        vendor_count += kind == "third-party-license"
        seen.add(relative)
    require(
        REQUIRED.issubset(seen), "Required project license or notice is not inventoried"
    )
    require(
        vendor_count > 0 and manifest.get("vendor_license_count") == vendor_count,
        "Vendor license count differs",
    )
    actual = license_tree(root) - {"LICENSES/manifest.json"}
    require(
        actual == {name for name in seen if name.startswith("LICENSES/")},
        "Unlisted or missing LICENSES files",
    )
    return {
        "protected_files": len(seen),
        "vendor_license_texts": vendor_count,
        "package_metadata": check_package_metadata(root),
    }


def main(argv=None):
    script_directory = Path(__file__).absolute().parent
    default_root = (
        script_directory.parent
        if script_directory.name == "scripts"
        else script_directory
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=default_root,
        help="Source or staged-runtime artifact root",
    )
    args = parser.parse_args(argv)
    try:
        result = check(args.root)
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        print(f"License check failed: {error}", file=sys.stderr)
        return 1
    print("License check passed: " + json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
