import { ConfidentialClientApplication } from '@azure/msal-node';
import { env } from '../../config/env.js';

const SCOPES = ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'];

function getMsalClient() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}`,
    },
  });
}

export function getMicrosoftAuthUrl(state: string): string {
  const cca = getMsalClient();
  const authUrl = `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize?client_id=${env.MICROSOFT_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(env.MICROSOFT_REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES.join(' '))}&state=${state}&response_mode=query`;
  return authUrl;
}

export async function exchangeMicrosoftCode(code: string) {
  const cca = getMsalClient();

  const result = await cca.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: env.MICROSOFT_REDIRECT_URI,
  });

  return {
    accessToken: result.accessToken,
    refreshToken: (result as any).refreshToken || null,
    tokenExpiry: result.expiresOn ? new Date(result.expiresOn) : null,
    email: result.account?.username || '',
    displayName: result.account?.name || null,
    scopes: SCOPES,
  };
}
