interface CapacitorConfig {
  appId: string;
  appName: string;
  webDir: string;
  server?: {
    androidScheme?: string;
    iosScheme?: string;
    url?: string;
    cleartext?: boolean;
  };
  android?: {
    backgroundColor?: string;
    allowMixedContent?: boolean;
    captureInput?: boolean;
    webContentsDebuggingEnabled?: boolean;
  };
  ios?: {
    backgroundColor?: string;
    contentInset?: string;
    limitsNavigationsToAppBoundDomains?: boolean;
  };
  plugins?: Record<string, unknown>;
}

const config: CapacitorConfig = {
  appId: 'com.sellora.store',
  appName: 'SELLORA',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    cleartext: false,
    // Bundled WebView builds use VITE_API_BASE_URL (e.g. https://sellora-commerce.<subdomain>.workers.dev)
    // to share the Cloudflare Worker API, D1 database, and R2 media endpoints with Web.
  },
  android: {
    backgroundColor: '#172554',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    backgroundColor: '#172554',
    contentInset: 'automatic',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1800,
      launchAutoHide: true,
      backgroundColor: '#172554',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
  },
};

export default config;
