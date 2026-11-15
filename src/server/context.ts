import type { SelloraDb, SelloraStorage } from './db';
import type { AuthUserSession, createSelloraAuth } from './auth';
import type { EmailEnvConfig } from './email';

export interface AppEnvConfig extends EmailEnvConfig {
  betterAuthSecret: string;
  ownerEmail?: string;
  turnstileSecretKey?: string;
  turnstileSiteKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleSiteVerification?: string;
  gaMeasurementId?: string;
  brevoWebhookSecret?: string;
  geminiApiKey?: string;
}

export type AppContext = {
  Variables: {
    db: SelloraDb;
    storage: SelloraStorage;
    auth: ReturnType<typeof createSelloraAuth>;
    user: AuthUserSession | null;
    env: AppEnvConfig;
  };
};
