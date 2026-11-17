"""Provision customer authentication in Sydney; local callbacks unless --base-url is set."""
import argparse
import json
import os
import secrets
import sys
from pathlib import Path
from urllib.parse import urlparse

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import dotenv_values

from storage import REGION, DEFAULT_TABLE


def validate_origin(url):
    parsed = urlparse(url)
    if (parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username or parsed.password
            or not parsed.hostname or (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname == 'localhost'))):
        raise ValueError('Use an HTTPS origin, or http://localhost:5050 for local testing')
    return url.rstrip('/')


def provision(profile, base_url, output, table_name=DEFAULT_TABLE):
    base_url = validate_origin(base_url)
    session = boto3.Session(profile_name=profile, region_name=REGION)
    client = session.client('cognito-idp', config=Config(retries={'mode': 'standard', 'total_max_attempts': 4},
                                                       connect_timeout=5, read_timeout=15))
    config = dict(dotenv_values(output)) if output.exists() else {}
    if config.get('APP_BASE_URL') and config['APP_BASE_URL'] != base_url:
        raise ValueError('Existing authentication uses a different origin. Use the documented read-modify-write deployment procedure.')

    def save_config():
        # No credentials, passwords, or Cognito secrets are printed to stdout.
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + '.tmp')
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as stream:
            for name, value in config.items():
                if value is not None:
                    stream.write(f'{name}={json.dumps(str(value))}\n')
        os.replace(temporary, output)
        os.chmod(output, 0o600)

    config.setdefault('FLASK_SECRET_KEY', os.environ.get('FLASK_SECRET_KEY') or secrets.token_urlsafe(48))
    config['APP_BASE_URL'] = base_url
    config['AWS_REGION'] = REGION
    config['DYNAMODB_TABLE'] = table_name
    if profile:
        config['AWS_PROFILE'] = profile
    if not config.get('COGNITO_POOL_ID'):
        pools = [pool for page in client.get_paginator('list_user_pools').paginate(MaxResults=60)
                 for pool in page['UserPools'] if pool['Name'] == 'happy-knots-customers']
        if pools:
            raise ValueError('A Happy Knots user pool already exists without this configuration; inspect it instead of duplicating it')
        pool = client.create_user_pool(
            PoolName='happy-knots-customers', UserPoolTier='ESSENTIALS', DeletionProtection='ACTIVE',
            UsernameAttributes=['email'], AutoVerifiedAttributes=['email'],
            UsernameConfiguration={'CaseSensitive': False},
            Policies={'PasswordPolicy': {'MinimumLength': 12, 'RequireUppercase': True,
                                         'RequireLowercase': True, 'RequireNumbers': True, 'RequireSymbols': True}},
            AccountRecoverySetting={'RecoveryMechanisms': [{'Priority': 1, 'Name': 'verified_email'}]},
            UserAttributeUpdateSettings={'AttributesRequireVerificationBeforeUpdate': ['email']},
            Schema=[{'Name': 'email', 'AttributeDataType': 'String', 'Required': True, 'Mutable': True}],
            UserPoolTags={'Application': 'HappyKnots'})['UserPool']
        config['COGNITO_POOL_ID'] = pool['Id']
        save_config()
    pool_id = config['COGNITO_POOL_ID']
    client.set_user_pool_mfa_config(UserPoolId=pool_id, MfaConfiguration='ON',
                                  SoftwareTokenMfaConfiguration={'Enabled': True})
    if not config.get('COGNITO_CLIENT_ID'):
        app_client = client.create_user_pool_client(
            UserPoolId=pool_id, ClientName='happy-knots-flask', GenerateSecret=True,
            AllowedOAuthFlowsUserPoolClient=True, AllowedOAuthFlows=['code'],
            AllowedOAuthScopes=['openid', 'email', 'profile'], SupportedIdentityProviders=['COGNITO'],
            CallbackURLs=[base_url + '/account/callback'], LogoutURLs=[base_url + '/'],
            ExplicitAuthFlows=['ALLOW_USER_SRP_AUTH'], EnableTokenRevocation=True,
            RefreshTokenRotation={'Feature': 'ENABLED', 'RetryGracePeriodSeconds': 10},
            PreventUserExistenceErrors='ENABLED', AccessTokenValidity=15, IdTokenValidity=15, RefreshTokenValidity=30,
            TokenValidityUnits={'AccessToken': 'minutes', 'IdToken': 'minutes', 'RefreshToken': 'days'},
            ReadAttributes=['email', 'email_verified', 'name'], WriteAttributes=['email', 'name'])['UserPoolClient']
        config.update(COGNITO_CLIENT_ID=app_client['ClientId'], COGNITO_CLIENT_SECRET=app_client['ClientSecret'])
        save_config()
    prefix = 'happy-knots-' + pool_id.split('_', 1)[1].lower()
    domain = client.describe_user_pool_domain(Domain=prefix)['DomainDescription']
    if not domain.get('UserPoolId'):
        client.create_user_pool_domain(UserPoolId=pool_id, Domain=prefix, ManagedLoginVersion=2)
    elif domain['UserPoolId'] != pool_id:
        raise ValueError('Cognito domain is owned by a different pool')
    config['COGNITO_DOMAIN'] = f'https://{prefix}.auth.{REGION}.amazoncognito.com'
    save_config()
    try:
        client.describe_managed_login_branding_by_client(UserPoolId=pool_id, ClientId=config['COGNITO_CLIENT_ID'])
    except client.exceptions.ResourceNotFoundException:
        client.create_managed_login_branding(UserPoolId=pool_id, ClientId=config['COGNITO_CLIENT_ID'], UseCognitoProvidedValues=True)
    dynamodb = session.client('dynamodb')
    ttl = dynamodb.describe_time_to_live(TableName=table_name)['TimeToLiveDescription']
    if ttl['TimeToLiveStatus'] == 'DISABLED':
        dynamodb.update_time_to_live(TableName=table_name, TimeToLiveSpecification={'Enabled': True, 'AttributeName': 'expires_at'})
    elif ttl.get('AttributeName') != 'expires_at':
        raise ValueError('Existing TTL uses another attribute; review before changing')
    print(json.dumps({'region': REGION, 'pool': pool_id, 'domain': config['COGNITO_DOMAIN'],
                      'base_url': base_url, 'configuration_file': str(output), 'mfa': 'authenticator-required'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default=os.environ.get('AWS_PROFILE'))
    parser.add_argument('--base-url', default='http://localhost:5050')
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / '.env.auth')
    args = parser.parse_args()
    try:
        provision(args.profile, args.base_url, args.output)
        return 0
    except (ValueError, ClientError, BotoCoreError) as exc:
        print(f'Authentication setup failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
