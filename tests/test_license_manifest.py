"""Offline release-license integrity tests; all mutations use synthetic temp files."""

import contextlib
import hashlib
import importlib.util
import io
import json
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "noda_license_checker", ROOT / "scripts/check-licenses.py"
)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class LicenseManifestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="noda-license-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.put("LICENSE", (ROOT / "LICENSE").read_bytes())
        self.put("NOTICE", b"Synthetic project required notice\n")
        self.put("THIRD_PARTY_NOTICES.md", b"Synthetic component attribution\n")
        self.put(
            "LICENSES/example/LICENSE", b"Synthetic permissive component license\n"
        )
        self.records = []
        for name in (
            "LICENSE",
            "NOTICE",
            "THIRD_PARTY_NOTICES.md",
            "LICENSES/example/LICENSE",
        ):
            kind = "project-license" if name == "LICENSE" else "required-notice"
            if name.startswith("LICENSES/"):
                kind = "third-party-license"
            self.records.append(
                {"path": name, "sha256": self.digest(name), "kind": kind}
            )
        self.manifest = {
            "schema": CHECKER.SCHEMA,
            "project_license": CHECKER.LICENSE_ID,
            "project_version": CHECKER.VERSION,
            "vendor_license_count": 1,
            "files": self.records,
        }
        self.save_manifest()
        self.package = {
            "name": "noda",
            "version": CHECKER.VERSION,
            "license": CHECKER.LICENSE_ID,
        }

    def put(self, relative, data):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)

    def digest(self, relative):
        return hashlib.sha256((self.root / relative).read_bytes()).hexdigest()

    def save_manifest(self):
        self.put("LICENSES/manifest.json", json.dumps(self.manifest).encode())

    def packages(self):
        self.put("frontend/package.json", json.dumps(self.package).encode())
        lock = {
            "name": "noda",
            "version": CHECKER.VERSION,
            "packages": {"": self.package},
        }
        self.put("frontend/package-lock.json", json.dumps(lock).encode())

    def test_runtime_without_frontend_metadata_passes(self):
        result = CHECKER.check(self.root)
        self.assertEqual(result["vendor_license_texts"], 1)
        self.assertEqual(
            result["package_metadata"], "not present in runtime-only artifact"
        )

    def test_source_metadata_passes(self):
        self.packages()
        self.assertEqual(CHECKER.check(self.root)["package_metadata"], "verified")

    def test_missing_and_tampered_vendor_or_required_notice_fail(self):
        for relative in (
            "LICENSES/example/LICENSE",
            "NOTICE",
            "THIRD_PARTY_NOTICES.md",
        ):
            with self.subTest(relative=relative):
                original = (self.root / relative).read_bytes()
                self.put(relative, original + b"tampered")
                with self.assertRaisesRegex(CHECKER.LicenseCheckError, "hash mismatch"):
                    CHECKER.check(self.root)
                (self.root / relative).unlink()
                with self.assertRaises(OSError):
                    CHECKER.check(self.root)
                self.put(relative, original)

    def test_rehashing_modified_project_license_does_not_replace_canonical_text(self):
        self.put("LICENSE", b"MIT instead of the canonical project license")
        self.records[0]["sha256"] = self.digest("LICENSE")
        self.save_manifest()
        with self.assertRaisesRegex(CHECKER.LicenseCheckError, "Canonical"):
            CHECKER.check(self.root)

    def test_source_wrong_license_name_or_version_fails(self):
        for key, value in (("license", "MIT"), ("version", "1.0.0"), ("name", "other")):
            with self.subTest(key=key):
                original = self.package[key]
                self.package[key] = value
                self.packages()
                with self.assertRaises(CHECKER.LicenseCheckError):
                    CHECKER.check(self.root)
                self.package[key] = original

    def test_lockfile_root_and_top_level_are_checked(self):
        self.packages()
        lock_path = self.root / "frontend/package-lock.json"
        for top in (False, True):
            with self.subTest(top=top):
                lock = json.loads(lock_path.read_text())
                target = lock if top else lock["packages"][""]
                target["version"] = "old"
                lock_path.write_text(json.dumps(lock))
                with self.assertRaises(CHECKER.LicenseCheckError):
                    CHECKER.check(self.root)
                self.packages()

    def test_only_one_source_metadata_file_is_rejected(self):
        self.packages()
        (self.root / "frontend/package-lock.json").unlink()
        with self.assertRaisesRegex(CHECKER.LicenseCheckError, "incomplete"):
            CHECKER.check(self.root)

    def test_traversal_absolute_and_windows_alias_paths_fail(self):
        for value in (
            "LICENSES/../NOTICE",
            "/NOTICE",
            "C:/NOTICE",
            "LICENSES\\NOTICE",
            "LICENSES/./x",
            "LICENSES//x",
            "LICENSES/x:stream",
            "LICENSES/x.",
            "LICENSES/x ",
            "LICENSES/\0x",
        ):
            with self.subTest(path=value):
                with self.assertRaises(CHECKER.LicenseCheckError):
                    CHECKER.safe_path(self.root, value)

    def test_duplicate_records_unknown_kind_and_invalid_digest_fail(self):
        self.records.append(dict(self.records[-1]))
        self.save_manifest()
        with self.assertRaisesRegex(CHECKER.LicenseCheckError, "Duplicate manifest"):
            CHECKER.check(self.root)
        self.records.pop()
        for field, value in (
            ("kind", "unknown"),
            ("sha256", "not-a-hash"),
            ("path", "backend/private-file"),
        ):
            with self.subTest(field=field):
                old = self.records[-1][field]
                self.records[-1][field] = value
                self.save_manifest()
                with self.assertRaises(CHECKER.LicenseCheckError):
                    CHECKER.check(self.root)
                self.records[-1][field] = old

    def test_unknown_license_file_or_uninventoried_notice_fails(self):
        self.put("LICENSES/unreviewed.txt", b"Unreviewed component")
        with self.assertRaisesRegex(CHECKER.LicenseCheckError, "Unlisted"):
            CHECKER.check(self.root)
        (self.root / "LICENSES/unreviewed.txt").unlink()
        self.records.remove(self.records[1])
        self.save_manifest()
        with self.assertRaisesRegex(CHECKER.LicenseCheckError, "Required project"):
            CHECKER.check(self.root)

    def test_manifest_schema_count_and_json_fail_closed(self):
        for key, value in (
            ("schema", "future"),
            ("vendor_license_count", 0),
            ("project_license", "MIT"),
            ("project_version", "old"),
            ("files", []),
        ):
            with self.subTest(field=key):
                original = self.manifest[key]
                self.manifest[key] = value
                self.save_manifest()
                with self.assertRaises(CHECKER.LicenseCheckError):
                    CHECKER.check(self.root)
                self.manifest[key] = original
        self.put("LICENSES/manifest.json", b'{"schema":"one","schema":"two"}')
        with self.assertRaisesRegex(CHECKER.LicenseCheckError, "Duplicate JSON"):
            CHECKER.check(self.root)

    def test_reparse_and_special_nodes_are_rejected_before_read(self):
        reparse = SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=1024)
        special = SimpleNamespace(st_mode=stat.S_IFIFO, st_file_attributes=0)
        for info, message in ((reparse, "Reparse"), (special, "Special")):
            with self.subTest(message=message), patch.object(
                Path, "lstat", return_value=info
            ):
                with self.assertRaisesRegex(CHECKER.LicenseCheckError, message):
                    CHECKER.checked_stat(self.root / "untrusted")

    def test_real_symlink_to_outside_is_rejected(self):
        link = self.root / "LICENSES/outside"
        try:
            link.symlink_to(self.root / "NOTICE")
        except OSError:
            self.skipTest(
                "This Windows account cannot create a symlink; reparse-flag guard is tested separately"
            )
        with self.assertRaisesRegex(CHECKER.LicenseCheckError, "Symbolic link"):
            CHECKER.check(self.root)

    def test_cli_exit_status_and_safe_failure(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(CHECKER.main(["--root", str(self.root)]), 0)
        self.put("NOTICE", b"tampered")
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            self.assertEqual(CHECKER.main(["--root", str(self.root)]), 1)
        self.assertIn("License check failed", errors.getvalue())
        self.assertNotIn("tampered", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
