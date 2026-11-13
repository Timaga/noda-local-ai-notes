# Windows code signing

Noda's published beta.17 artifacts are unsigned. This repository provides an
explicit signed-build mode for a future version after a certificate authority
has validated the publisher and supplied a suitable code-signing identity.
Configuration support alone is not evidence that an artifact has been signed.

## Obtain the identity first

Use a publicly trusted Authenticode code-signing certificate whose private key
is accessible through the Windows certificate store, normally through the
issuer's hardware-token driver. Keep the key in its approved provider. Do not
export a private key, add certificate passwords to configuration, or commit
identity documents, certificate containers or token PINs.

Confirm the issuer's eligibility, identity-verification process, delivery options
and complete price before ordering. Country lists and individual/company rules
vary between providers. A general list of country codes does not establish that
a provider will issue a code-signing certificate to a particular applicant.

The publisher must match the authority's validated legal identity. An arbitrary
brand or preferred display name cannot replace that validation. Submit identity
documents directly through the chosen issuer's official verification process.

## Build and verify

Run from the repository root after the issuer's identity is installed:

```powershell
$signingThumbprint = Read-Host 'Validated code-signing certificate thumbprint'
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows-portable/build.ps1 -Installer -Sign -CertificateThumbprint $signingThumbprint
```

The thumbprint selects a certificate; it is not a password. The SHA-1 thumbprint
identifier does not select the signature's digest: signed builds use SHA-256.
The default RFC 3161 timestamp service is the electron-builder v26 default,
`http://timestamp.digicert.com`. Use `-TimestampServer` if the issuer specifies
another HTTP(S) RFC 3161 service. Timestamping sends a signing digest, not the
application's notes or source code. Actual signing may require the token's own
secure PIN prompt and network access for timestamp/revocation checks.

An actual signed build:

- validates the selected Windows code-signing identity, private-key availability,
  validity dates and trust chain before downloading or staging the application;
- enables signing and `forceCodeSigning` for electron-builder 26.18.1, including
  its normal NSIS installer/uninstaller signing stages;
- requires the final Noda.exe and Setup to have a valid embedded Authenticode
  signature from the selected identity and a timestamp;
- fails on a missing certificate, failed signing or failed artifact verification.

`-StageOnly -Sign -CertificateThumbprint ...` previews the configuration without
using a key or producing an executable. It does not validate an installed identity
or prove signing. `-SourceOnly` cannot be combined with `-Sign`. Existing unsigned
development builds remain available by omitting `-Sign`.

Before distribution, inspect the exact installer contents and verify the embedded
uninstaller's signature as well. Run the clean-machine install/update/recovery
acceptance checks. Generate checksums only after signing and use a new version;
preserve already published beta.17 files and their hashes. Signing does not
guarantee an immediate SmartScreen reputation or resolve application advisories.

## References

- [electron-builder v26 Windows signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)
- [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Microsoft Artifact Signing eligibility](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [HARICA individual code-signing validation](https://www.harica.gr/en/guides/code-signing-certificate-request-for-individuals-or-sole-proprietorships-iv/)

No certificate order or paid signing service is created by the build scripts.
The signing change adds no application screen or transition to the Miro map.
