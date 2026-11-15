interface CapacitorConfig {
  appId: string;
  appName: string;
  webDir: string;
  server?: {
    androidScheme?: string;
    url?: string;
    cleartext?: boolean;
  };
  android?: {
    backgroundColor?: string;
    allowMixedContent?: boolean;
    captureInput?: boolean;
    webContentsDebuggingEnabled?: boolean;
  };
  plugins?: Record<string, unknown>;
}

const config: CapacitorConfig = {
  appId: 'com.sellora.store',
  appName: 'SELLORA',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // Set url during live remote-hosted builds or leave bundled with VITE_API_BASE_URL
  },
  android: {
    backgroundColor: '#172554',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
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
