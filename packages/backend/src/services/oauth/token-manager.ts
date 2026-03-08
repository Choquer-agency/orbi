import { google } from 'googleapis';
import { ConfidentialClientApplication } from '@azure/msal-node';
import type { PrismaClient, Account } from '@prisma/client';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { env } from '../../config/env.js';

export class TokenManager {
  constructor(private prisma: PrismaClient) {}

  encryptToken(token: string): string {
    return encrypt(token);
  }

  decryptToken(encrypted: string): string {
    return decrypt(encrypted);
  }

  async getValidAccessToken(account: Account): Promise<string> {
    const now = new Date();

    // Check if token is still valid (with 5 min buffer)
    if (account.tokenExpiry && account.tokenExpiry.getTime() > now.getTime() + 5 * 60 * 1000) {
      return this.decryptToken(account.accessToken);
    }

    // Need to refresh
    if (!account.refreshToken) {
      throw new Error(`No refresh token available for account ${account.id}`);
    }

    const refreshToken = this.decryptToken(account.refreshToken);

    if (account.provider === 'GMAIL') {
      return this.refreshGmailToken(account, refreshToken);
    } else if (account.provider === 'MICROSOFT') {
      return this.refreshMicrosoftToken(account, refreshToken);
    }

    throw new Error(`Token refresh not supported for provider ${account.provider}`);
  }

  private async refreshGmailToken(account: Account, refreshToken: string): Promise<string> {
    const oauth2Client = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );

    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();

    const newAccessToken = credentials.access_token!;
    const expiry = credentials.expiry_date ? new Date(credentials.expiry_date) : null;

    await this.prisma.account.update({
      where: { id: account.id },
      data: {
        accessToken: this.encryptToken(newAccessToken),
        tokenExpiry: expiry,
      },
    });

    return newAccessToken;
  }

  private async refreshMicrosoftToken(account: Account, refreshToken: string): Promise<string> {
    const cca = new ConfidentialClientApplication({
      auth: {
        clientId: env.MICROSOFT_CLIENT_ID,
        clientSecret: env.MICROSOFT_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}`,
      },
    });

    const result = await cca.acquireTokenByRefreshToken({
      refreshToken,
      scopes: ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'],
    });

    if (!result) {
      throw new Error('Failed to refresh Microsoft token');
    }

    const newAccessToken = result.accessToken;
    const expiry = result.expiresOn ? new Date(result.expiresOn) : null;

    await this.prisma.account.update({
      where: { id: account.id },
      data: {
        accessToken: this.encryptToken(newAccessToken),
        tokenExpiry: expiry,
      },
    });

    return newAccessToken;
  }
}
