import { env } from '../../config/env.js';

// Lazy-loaded APNs provider — only initialized when first push is sent.
// This avoids startup errors in dev environments without APNs credentials.
let apnsProvider: any = null;
let initAttempted = false;

function getApnsKey(): string | null {
  // Prefer base64-encoded key content (for cloud/Vercel deployments)
  if (env.APNS_KEY_CONTENT) {
    return Buffer.from(env.APNS_KEY_CONTENT, 'base64').toString('utf-8');
  }
  // Fall back to file path (for local dev)
  if (env.APNS_KEY_PATH) {
    return env.APNS_KEY_PATH;
  }
  return null;
}

export function isApnsConfigured(): boolean {
  return !!(env.APNS_KEY_ID && env.APNS_TEAM_ID && getApnsKey());
}

export async function getApnsProvider(): Promise<any | null> {
  if (apnsProvider) return apnsProvider;
  if (initAttempted) return null;

  initAttempted = true;

  if (!isApnsConfigured()) {
    console.log('[apns] APNs not configured — push notifications disabled');
    return null;
  }

  try {
    const apn = await import('@parse/node-apn');
    const key = getApnsKey()!;

    const options: any = {
      token: {
        key: env.APNS_KEY_CONTENT ? { toString: () => key } : key,
        keyId: env.APNS_KEY_ID!,
        teamId: env.APNS_TEAM_ID!,
      },
      production: env.APNS_PRODUCTION,
    };

    // @parse/node-apn expects key as string content or file path
    // When using APNS_KEY_CONTENT, we pass the decoded string directly
    if (env.APNS_KEY_CONTENT) {
      options.token.key = key;
    }

    apnsProvider = new apn.Provider(options);
    console.log(
      `[apns] Provider initialized (${env.APNS_PRODUCTION ? 'production' : 'sandbox'})`,
    );
    return apnsProvider;
  } catch (err: any) {
    console.error('[apns] Failed to initialize provider:', err.message);
    return null;
  }
}

export function shutdownApns(): void {
  if (apnsProvider) {
    apnsProvider.shutdown();
    apnsProvider = null;
    initAttempted = false;
  }
}
