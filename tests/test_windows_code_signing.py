"""Windows signing preflight and artifact rejection, without an installed key."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts/windows-portable"
THUMBPRINT = "0" * 40  # Synthetic test identifier, not an installed certificate.
pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows Authenticode")


def environment():
    return {
        key: value for key, value in os.environ.items() if key.lower() != "psmodulepath"
    }


def run_helper(tmp_path, body):
    harness = tmp_path / "check-signing.ps1"
    harness.write_text(
        "$ErrorActionPreference = 'Stop'\n"
        ". (Join-Path $env:NODA_TEST_SIGNING_SCRIPTS 'signing.ps1')\n" + body,
        encoding="utf-8",
    )
    return subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(harness),
        ],
        cwd=tmp_path,
        env={**environment(), "NODA_TEST_SIGNING_SCRIPTS": str(SCRIPTS)},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def run_build(output, *options):
    return subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SCRIPTS / "build.ps1"),
            "-OutputDirectory",
            str(output),
            *options,
        ],
        cwd=ROOT,
        env=environment(),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


@pytest.mark.parametrize("installer", [False, True], ids=["portable", "installer"])
def test_signed_preview_requires_signing_for_every_build_and_uses_sha256(
    tmp_path, installer
):
    output = tmp_path / "preview"
    options = ["-Installer"] if installer else []
    result = run_build(
        output, "-StageOnly", "-Sign", "-CertificateThumbprint", THUMBPRINT, *options
    )
    assert result.returncode == 0, result.stderr
    kind = "installer" if installer else "portable"
    config = json.loads(
        (output / f"electron-builder.{kind}.json").read_text(encoding="utf-8")
    )
    assert config["forceCodeSigning"] is True
    assert config["win"]["signExecutable"] is True
    assert config["win"]["signtoolOptions"] == {
        "certificateSha1": THUMBPRINT,
        "signingHashAlgorithms": ["sha256"],
        "rfc3161TimeStampServer": "http://timestamp.digicert.com",
    }
    assert not (
        output / "dist"
    ).exists()  # This is configuration, not a signed release.


@pytest.mark.parametrize(
    "options,error",
    [
        (["-Sign"], "40-character"),
        (["-Sign", "-CertificateThumbprint", "not-a-certificate"], "40-character"),
        (["-CertificateThumbprint", THUMBPRINT], "Use -Sign"),
        (["-Sign", "-SourceOnly"], "Source exports cannot be code-signed"),
        (
            [
                "-Sign",
                "-CertificateThumbprint",
                THUMBPRINT,
                "-TimestampServer",
                "file:///C:/test",
            ],
            "HTTP(S)",
        ),
        (
            [
                "-Sign",
                "-CertificateThumbprint",
                THUMBPRINT,
                "-TimestampServer",
                "https://user:invalid@example.invalid",
            ],
            "HTTP(S)",
        ),
    ],
)
def test_invalid_signing_request_fails_before_staging_or_downloading(
    tmp_path, options, error
):
    output = tmp_path / "rejected"
    result = run_build(output, *options)
    assert result.returncode != 0
    assert error in result.stderr
    assert not output.exists()


def test_actual_signed_build_refuses_missing_identity_before_touching_outputs(tmp_path):
    output = tmp_path / "rejected"
    result = run_build(
        output, "-Installer", "-Sign", "-CertificateThumbprint", THUMBPRINT
    )
    assert result.returncode != 0
    assert "not installed in the Windows personal stores" in result.stderr
    assert not output.exists()


@pytest.mark.parametrize(
    "condition,error",
    [
        (
            "$false; $before=(Get-Date).AddDays(-1); $after=(Get-Date).AddDays(1)",
            "no accessible private-key",
        ),
        (
            "$true; $before=(Get-Date).AddDays(-2); $after=(Get-Date).AddDays(-1)",
            "not currently valid",
        ),
    ],
)
def test_identity_rejects_missing_key_and_expired_certificate(
    tmp_path, condition, error
):
    result = run_helper(
        tmp_path,
        f"""
$hasKey = {condition}
function Get-ChildItem {{
    param($Path, [switch]$CodeSigningCert)
    [pscustomobject]@{{Thumbprint='{THUMBPRINT}';HasPrivateKey=$hasKey;NotBefore=$before;NotAfter=$after}}
}}
Assert-NodaSigningIdentity '{THUMBPRINT}'
""",
    )
    assert result.returncode != 0
    assert error in result.stderr


def test_identity_rejects_an_ephemeral_untrusted_certificate_without_installing_it(
    tmp_path,
):
    result = run_helper(
        tmp_path,
        """
$rsa = [Security.Cryptography.RSACng]::new(2048)
$request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=Noda Synthetic Untrusted Test', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1)
$eku = [Security.Cryptography.OidCollection]::new()
[void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
$request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
function Get-ChildItem { param($Path, [switch]$CodeSigningCert); $certificate }
try { Assert-NodaSigningIdentity $certificate.Thumbprint }
finally { $certificate.Dispose(); $rsa.Dispose() }
""",
    )
    assert result.returncode != 0
    assert "chain and revocation validation" in result.stderr


@pytest.mark.parametrize(
    "status,kind,thumb,timestamp",
    [
        ("NotSigned", "None", THUMBPRINT, "$null"),
        ("HashMismatch", "Authenticode", THUMBPRINT, "[pscustomobject]@{}"),
        ("Valid", "Catalog", THUMBPRINT, "[pscustomobject]@{}"),
        ("Valid", "Authenticode", "1" * 40, "[pscustomobject]@{}"),
        ("Valid", "Authenticode", THUMBPRINT, "$null"),
    ],
)
def test_artifact_rejects_bad_signatures_wrong_publisher_and_missing_timestamp(
    tmp_path, status, kind, thumb, timestamp
):
    artifact = tmp_path / "synthetic.exe"
    artifact.write_bytes(b"Synthetic test data, not an executable")
    result = run_helper(
        tmp_path,
        f"""
function Get-AuthenticodeSignature {{
    param($LiteralPath)
    [pscustomobject]@{{Status='{status}';SignatureType='{kind}';
        SignerCertificate=[pscustomobject]@{{Thumbprint='{thumb}'}};TimeStamperCertificate={timestamp}}}
}}
Assert-NodaSignedArtifact 'synthetic.exe' '{THUMBPRINT}'
""",
    )
    assert result.returncode != 0
    assert "embedded-signature, publisher and timestamp verification" in result.stderr


def test_artifact_rejects_a_real_unsigned_file(tmp_path):
    (tmp_path / "synthetic.exe").write_bytes(b"Synthetic test data, not an executable")
    result = run_helper(
        tmp_path, f"Assert-NodaSignedArtifact 'synthetic.exe' '{THUMBPRINT}'"
    )
    assert result.returncode != 0
    assert "embedded-signature, publisher and timestamp verification" in result.stderr
