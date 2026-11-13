function Get-NodaSigningOptions {
    param([string]$CertificateThumbprint, [string]$TimestampServer)

    if ($CertificateThumbprint -notmatch '^[A-Fa-f0-9]{40}$') {
        throw 'Signed builds require a 40-character code-signing certificate thumbprint.'
    }
    $timestamp = $null
    if (-not [Uri]::TryCreate($TimestampServer, [UriKind]::Absolute, [ref]$timestamp) -or
        $timestamp.Scheme -notin @('http', 'https') -or -not $timestamp.Host -or
        $timestamp.UserInfo -or $timestamp.Fragment) {
        throw 'Choose an HTTP(S) RFC 3161 timestamp server without credentials or a fragment.'
    }
    return [ordered]@{
        certificateSha1 = $CertificateThumbprint.ToUpperInvariant()
        signingHashAlgorithms = @('sha256')
        rfc3161TimeStampServer = $TimestampServer
    }
}

function Assert-NodaSigningIdentity {
    param([string]$CertificateThumbprint)

    $certificates = @(Get-ChildItem -Path Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert -ErrorAction Stop |
        Where-Object { $_.Thumbprint -eq $CertificateThumbprint })
    if ($certificates.Count -eq 0) {
        throw 'The selected code-signing certificate is not installed in the Windows personal stores.'
    }
    $certificate = $certificates | Where-Object HasPrivateKey | Select-Object -First 1
    if (-not $certificate) { throw 'The selected certificate has no accessible private-key provider.' }
    $now = Get-Date
    if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
        throw 'The selected code-signing certificate is not currently valid.'
    }
    $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        $chain.ChainPolicy.RevocationMode = 'Online'
        $chain.ChainPolicy.VerificationFlags = 'NoFlag'
        $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)
        [void]$chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
        if (-not $chain.Build($certificate)) {
            throw 'The selected certificate did not pass Windows code-signing chain and revocation validation.'
        }
    } finally {
        $chain.Dispose()
    }
}

function Assert-NodaSignedArtifact {
    param([string]$Path, [string]$CertificateThumbprint)

    $file = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A signed artifact must be a regular file.'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName -ErrorAction Stop
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
        -not $signature.SignerCertificate -or
        $signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or
        -not $signature.TimeStamperCertificate) {
        throw 'A signed artifact did not pass embedded-signature, publisher and timestamp verification.'
    }
}
