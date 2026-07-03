# Code-signing the Windows build

The `.exe`/installer from `npm run build` is **unsigned** by default. On first run Windows
SmartScreen shows an "unknown publisher — Windows protected your PC" prompt; the recipient
clicks **More info → Run anyway** once. For a one-off personal gift that is genuinely fine and
needs zero setup. Sign only if you want that prompt gone.

electron-builder signs automatically when a certificate is provided via the environment (no
secrets committed):

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"     # or a base64 string of the .pfx
$env:CSC_KEY_PASSWORD = "the-pfx-password"
npm run build
```

`electron-builder.yml` already sets the RFC-3161 timestamp server and SHA-256, so a supplied
cert produces a properly timestamped signature. Uncomment `publisherName` there to match the
certificate's subject CN.

## Which certificate — and what each actually achieves

| Option | Cost / effort | Removes "unknown publisher"? | Instant SmartScreen trust? |
|---|---|---|---|
| **No signing** (default) | none | no | n/a — one click-through |
| **Self-signed** | free | only on machines where you import it | no |
| **OV cert** (CA, e.g. Sectigo/DigiCert) | ~$200+/yr, hardware/cloud HSM | yes | no — reputation builds over downloads |
| **EV cert** | more $$, hardware token | yes | yes |

Key reality: a **self-signed** cert does *not* make Windows trust the app on the recipient's
machine unless you also import the cert into their **Trusted Root / Trusted Publishers** store
(an admin step) — often more hassle than the one click-through. Real trust needs a CA-issued
cert; **instant** SmartScreen reputation needs **EV**. For a single gift, none of this is worth
it — but the plumbing is ready if you decide otherwise.

## Self-signed route (dev / internal — the warning stays unless imported)

Generate a cert and sign locally (Windows PowerShell, admin):

```powershell
# 1. Create a self-signed code-signing cert
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Vitaliy Khomenko" -CertStoreLocation Cert:\CurrentUser\My

# 2. Export it to a password-protected .pfx
$pw = ConvertTo-SecureString -String "choose-a-password" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath w17.pfx -Password $pw

# 3. Point electron-builder at it and build (see the env vars above)
$env:CSC_LINK = "w17.pfx"; $env:CSC_KEY_PASSWORD = "choose-a-password"; npm run build

# 4. (only to silence the warning on a given PC) import the cert as trusted there:
Import-PfxCertificate -FilePath w17.pfx -CertStoreLocation Cert:\LocalMachine\Root -Password $pw
```

Never commit the `.pfx` or its password. `w17.pfx` should be in `.gitignore` if you create one.
