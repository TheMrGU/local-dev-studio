/* Build the NSIS installer and portable exe, signed via Azure Trusted Signing
 * (rebranded Azure Artifact Signing — same service).
 *
 * This replaces "Unknown publisher" with "NightShyft Studios" in the install dialog. It does
 * not, on its own, guarantee the blue SmartScreen dialog goes away: reputation accrues to the
 * signing identity over time, and Microsoft's March 2026 intermediate-CA rotation reset it for
 * everyone. Expect the publisher name immediately and the SmartScreen prompt to fade as
 * downloads accumulate.
 *
 * Set up once in the Azure portal (Trusted Signing account -> certificate profile, after
 * identity validation clears), then create a service principal with the
 * "Trusted Signing Certificate Profile Signer" role and export:
 *
 *   set AZURE_TENANT_ID=...
 *   set AZURE_CLIENT_ID=...
 *   set AZURE_CLIENT_SECRET=...
 *   set AZURE_SIGNING_ENDPOINT=https://eus.codesigning.azure.net
 *   set AZURE_SIGNING_ACCOUNT=your-trusted-signing-account
 *   set AZURE_SIGNING_PROFILE=your-certificate-profile
 *   npm run dist:signed
 *
 * The endpoint region has to match the region the signing account was created in.
 */
'use strict';
const { spawnSync } = require('child_process');

const required = {
  AZURE_TENANT_ID: 'service principal tenant',
  AZURE_CLIENT_ID: 'service principal application id',
  AZURE_CLIENT_SECRET: 'service principal secret',
  AZURE_SIGNING_ENDPOINT: 'e.g. https://eus.codesigning.azure.net',
  AZURE_SIGNING_ACCOUNT: 'Trusted Signing account name',
  AZURE_SIGNING_PROFILE: 'certificate profile name',
};

const missing = Object.keys(required).filter((key) => !process.env[key]);
if (missing.length) {
  console.error('Cannot sign — these are not set:\n');
  for (const key of missing) console.error(`  ${key}  (${required[key]})`);
  console.error('\nSee docs/windows-signing.md. For an unsigned build, use: npm run dist');
  process.exit(1);
}

const args = [
  '--win',
  `-c.win.azureSignOptions.endpoint=${process.env.AZURE_SIGNING_ENDPOINT}`,
  `-c.win.azureSignOptions.codeSigningAccountName=${process.env.AZURE_SIGNING_ACCOUNT}`,
  `-c.win.azureSignOptions.certificateProfileName=${process.env.AZURE_SIGNING_PROFILE}`,
  '-c.win.azureSignOptions.publisherName=NightShyft Studios',
];

const result = spawnSync('npx', ['electron-builder', ...args], { stdio: 'inherit', shell: true });
process.exit(result.status === null ? 1 : result.status);
