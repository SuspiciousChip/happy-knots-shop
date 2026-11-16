// One-time local setup. Run with AWS_PROFILE set to the project profile.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CognitoIdentityProviderClient, CreateUserPoolCommand, CreateUserPoolClientCommand, CreateUserPoolDomainCommand } from '@aws-sdk/client-cognito-identity-provider';
const region = 'ap-southeast-2';
const client = new CognitoIdentityProviderClient({ region });
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.mongo');
const contents = fs.readFileSync(envPath, 'utf8');
if (/^COGNITO_POOL_ID=/m.test(contents)) throw new Error('Customer identity configuration already exists');
const base = 'http://localhost:5050';
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
const lines = [
  `COGNITO_POOL_ID=${poolId}`, `COGNITO_ISSUER=https://cognito-idp.${region}.amazonaws.com/${poolId}`,
  `COGNITO_CLIENT_ID=${app.UserPoolClient.ClientId}`, `COGNITO_CLIENT_SECRET=${app.UserPoolClient.ClientSecret}`,
  `COGNITO_DOMAIN=https://${prefix}.auth.${region}.amazoncognito.com`, `APP_BASE_URL=${base}`
];
fs.appendFileSync(envPath, '\n# Customer sign-in (Cognito Lite, classic hosted UI)\n' + lines.join('\n') + '\n', { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
console.log('Customer sign-in configured in the ignored .env.mongo file.');
