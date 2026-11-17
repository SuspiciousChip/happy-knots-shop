// One-time local setup. Run with AWS_PROFILE set to the project profile.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CognitoIdentityProviderClient, CreateUserPoolCommand, CreateUserPoolClientCommand, CreateUserPoolDomainCommand } from '@aws-sdk/client-cognito-identity-provider';
import dotenv from 'dotenv';

const region = 'ap-southeast-2';
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.mongo');

export function hasConfiguredAuth(contents) {
  const config = dotenv.parse(contents);
  return Boolean((config.COGNITO_POOL_ID && config.COGNITO_POOL_ID !== `${region}_example`) ||
    (config.COGNITO_CLIENT_ID && config.COGNITO_CLIENT_ID !== 'example') ||
    (config.COGNITO_CLIENT_SECRET && !config.COGNITO_CLIENT_SECRET.startsWith('replace-with-')));
}

export function mergeAuthConfig(contents, values) {
  const seen = new Set();
  const updated = contents.split('\n').map(line => {
    const match = /^([A-Z_]+)=/.exec(line);
    if (!match || !(match[1] in values)) return line;
    if (seen.has(match[1])) return null;
    seen.add(match[1]);
    return `${match[1]}=${JSON.stringify(values[match[1]])}`;
  }).filter(line => line !== null);
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) updated.push(`${key}=${JSON.stringify(value)}`);
  }
  return updated.join('\n').replace(/\n*$/, '\n');
}

async function run() {
  const contents = fs.readFileSync(envPath, 'utf8');
  if (hasConfiguredAuth(contents)) throw new Error('Customer identity configuration already exists');
  const base = 'http://localhost:5050';
  const client = new CognitoIdentityProviderClient({ region });
  const pool = await client.send(new CreateUserPoolCommand({
    PoolName: 'happy-knots-customers', UserPoolTier: 'LITE', UsernameAttributes: ['email'], AutoVerifiedAttributes: ['email'],
    Policies: { PasswordPolicy: { MinimumLength: 12, RequireUppercase: true, RequireLowercase: true, RequireNumbers: true, RequireSymbols: true } },
    AccountRecoverySetting: { RecoveryMechanisms: [{ Priority: 1, Name: 'verified_email' }] },
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    VerificationMessageTemplate: { DefaultEmailOption: 'CONFIRM_WITH_CODE' },
    MfaConfiguration: 'OFF'
  }));
  const poolId = pool.UserPool.Id;
  const app = await client.send(new CreateUserPoolClientCommand({
    UserPoolId: poolId, ClientName: 'happy-knots-local-server', GenerateSecret: true,
    AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['code'], AllowedOAuthScopes: ['openid', 'email'],
    SupportedIdentityProviders: ['COGNITO'], CallbackURLs: [`${base}/account/callback`], LogoutURLs: [base],
    PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true, RefreshTokenValidity: 1,
    TokenValidityUnits: { RefreshToken: 'days' }
  }));
  const prefix = `happy-knots-${crypto.randomBytes(5).toString('hex')}`;
  await client.send(new CreateUserPoolDomainCommand({ UserPoolId: poolId, Domain: prefix, ManagedLoginVersion: 1 }));
  const values = {
    COGNITO_POOL_ID: poolId, COGNITO_ISSUER: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
    COGNITO_CLIENT_ID: app.UserPoolClient.ClientId, COGNITO_CLIENT_SECRET: app.UserPoolClient.ClientSecret,
    COGNITO_DOMAIN: `https://${prefix}.auth.${region}.amazoncognito.com`, APP_BASE_URL: base
  };
  const temporary = `${envPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, mergeAuthConfig(contents, values), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, envPath);
  fs.chmodSync(envPath, 0o600);
  console.log('Customer sign-in configured in the ignored .env.mongo file.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
