// app.config.ts
import 'dotenv/config';

const projectId = '774983f2-fd56-4e01-a6da-92d03bd0e378'; // EAS project ID

export default {
  expo: {
    name: 'Anvaya',
    slug: 'anvaya',
    owner: 'sgodphoenix',
    scheme: 'anvaya',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    platforms: ['android'],

    android: {
      package: 'com.mtm.anvaya',
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#121212',
      },
      permissions: [],
    },

    /**
     * EAS Update configuration (required because your build profile uses a channel).
     * SDK 54+ will auto-install the plugin when the package is present.
     */
    updates: {
      url: 'https://u.expo.dev/774983f2-fd56-4e01-a6da-92d03bd0e378',
    },
    runtimeVersion: {
      policy: 'appVersion', // ties runtime to app.version
    },

    extra: {
      eas: { projectId },
      MTM_PRICEBOOK_URL: process.env.MTM_PRICEBOOK_URL,

      // Secrets: loaded from local .env in dev or from EAS Envs on build
      ZOHO: {
        PM: {
          REFRESH: process.env.ZB_PM_REFRESH,
          CLIENT_ID: process.env.ZB_PM_CLIENT_ID,
          CLIENT_SECRET: process.env.ZB_PM_CLIENT_SECRET,
          ORG: process.env.ZB_PM_ORG,
        },
        MTM: {
          REFRESH: process.env.ZB_MTM_REFRESH,
          CLIENT_ID: process.env.ZB_MTM_CLIENT_ID,
          CLIENT_SECRET: process.env.ZB_MTM_CLIENT_SECRET,
          ORG: process.env.ZB_MTM_ORG,
        },
        RMD: {
          REFRESH: process.env.ZB_RMD_REFRESH,
          CLIENT_ID: process.env.ZB_RMD_CLIENT_ID,
          CLIENT_SECRET: process.env.ZB_RMD_CLIENT_SECRET,
          ORG: process.env.ZB_RMD_ORG,
        },
        MURLI: {
          REFRESH: process.env.ZB_MURLI_REFRESH,
          CLIENT_ID: process.env.ZB_MURLI_CLIENT_ID,
          CLIENT_SECRET: process.env.ZB_MURLI_CLIENT_SECRET,
          ORG: process.env.ZB_MURLI_ORG,
        },
      },
    },
  },
};
