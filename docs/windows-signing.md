# Getting rid of the Windows "unknown publisher" warning

SiteSlurp's downloadable builds are unsigned, so Windows shows two separate complaints:

- **"Unknown publisher"** in the install dialog — there is no code-signing certificate at all.
- **"Windows protected your PC"** (SmartScreen) — a reputation check. For an unsigned binary,
  reputation is tracked *per file hash*, so every release starts from zero and never improves.

Fixing them means getting a trusted publisher identity. Both routes below go through a human
identity review at Microsoft, so neither is same-day.

## What does not work

- **Self-signed certificates** make things worse. Windows treats an untrusted publisher as more
  suspicious than no publisher at all.
- **Zipping, renaming, or shipping through winget** does not clear SmartScreen.
- **Free code-signing certificates** do not exist. Since 2023 the private key has to live on an
  HSM, which is what puts the floor on commercial certificate pricing.

## Route 1 — Microsoft Store (free, no warning at all)

The Store re-signs your package with Microsoft's own certificate during certification. Users
never see SmartScreen or an unknown-publisher prompt, and you never buy or renew anything.
Microsoft has dropped the registration fee for both individual and company accounts, so this
route costs nothing.

1. Open a Partner Center developer account and reserve the app name **SiteSlurp Studio**.
2. From your app's **Product identity** page, copy the Package/Identity Name and the Publisher
   (`CN=…`) values.
3. Build the package on Windows — the appx target shells out to `makeappx.exe` from the
   Windows SDK, so it will not run on Linux or macOS:

   ```bat
   set APPX_IDENTITY_NAME=1234NightShyftStudios.SiteSlurpStudio
   set APPX_PUBLISHER=CN=ABCD1234-5678-90EF-1234-567890ABCDEF
   npm run dist:store
   ```

   Leave those unset and you still get a package, but a sideload-test-only one that Partner
   Center will reject.
4. Upload `dist/SiteSlurp-<version>-store.appx` and submit for certification.

Two things to check before investing much time here:

- **Full-trust behaviour.** SiteSlurp spawns external browsers, serves sites on localhost, and
  writes into `Documents`. All of that needs the package to run outside the AppContainer
  sandbox. electron-builder's appx target declares `runFullTrust`, which should cover it, but
  sideload the package and exercise capture → host → open-in-editor before submitting.
- **The AGPL dependency.** `single-file-cli` is AGPL-3.0 (see `THIRD-PARTY-NOTICES.md`).
  Microsoft has allowed copyleft-licensed apps in the Store for several years now, but confirm
  it against current Store policy rather than discovering it at certification.

## Route 2 — Azure Trusted Signing (~$10/month, keeps the current builds)

Now branded **Azure Artifact Signing**. Your existing NSIS installer and portable exe stay
exactly as they are; they just come out signed. No repackaging, no certification queue.

Identity validation needs a government-issued photo ID and a selfie, reviewed by Microsoft.
Self-employed individuals are eligible in the US, Canada, the EU and the UK — the old
three-years-of-trading requirement no longer applies to them. Budget several days.

1. Create an Azure subscription and a **Trusted Signing** account, then a certificate profile.
2. Complete identity validation and wait for it to clear.
3. Register a service principal and give it the **Trusted Signing Certificate Profile Signer**
   role on the profile.
4. Build:

   ```bat
   set AZURE_TENANT_ID=...
   set AZURE_CLIENT_ID=...
   set AZURE_CLIENT_SECRET=...
   set AZURE_SIGNING_ENDPOINT=https://eus.codesigning.azure.net
   set AZURE_SIGNING_ACCOUNT=your-trusted-signing-account
   set AZURE_SIGNING_PROFILE=your-certificate-profile
   npm run dist:signed
   ```

   The endpoint region must match the region the signing account was created in.

**Set expectations honestly here.** This reliably replaces "Unknown publisher" with "NightShyft
Studios". It does *not* reliably remove the SmartScreen dialog right now: in March 2026 Trusted
Signing moved onto new intermediate CAs (`Microsoft ID Verified CS AOC CA 03` and
`EOC CA 04`) without carrying SmartScreen reputation across, and developers have been reporting
fresh "unrecognized app" blocks on correctly signed binaries since. Reputation does rebuild as
downloads accumulate, and unlike the unsigned case it accrues to the signing identity rather
than resetting every release.

## Which to pick

They are not mutually exclusive, and the build scripts are independent — nothing here blocks
anything else.

- Want the warning **gone**, at no cost, and can wait for certification → Route 1.
- Want the **direct `.exe` downloads** to carry your name and build reputation over time →
  Route 2.
- Doing both gives a clean Store install path plus credible direct downloads.

## Sources

- [Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Free developer registration for individual developers](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer)
- [Trusted Signing pricing](https://azure.microsoft.com/en-us/pricing/details/trusted-signing/)
- [Trusted Signing open for individual developers](https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-is-now-open-for-individual-developers-to-sign-up-in-public-previ/4273554)
- [Trusted Signing: SmartScreen regression after CA transition](https://learn.microsoft.com/en-us/answers/questions/5855708/trusted-signing-regression-in-smartscreen-reputation)
- [electron-builder: Code signing for Windows](https://www.electron.build/docs/features/code-signing/code-signing-win/)
