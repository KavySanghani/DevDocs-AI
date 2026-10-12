/**
 * Safe frontend environment configuration.
 * Never store secret credentials in browser bundles.
 */
export const webConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '',
  mode: import.meta.env.MODE,
  isDev: import.meta.env.DEV,
} as const;
