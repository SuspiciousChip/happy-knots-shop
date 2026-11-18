const PRODUCTION_BASE_URL = 'https://www.happyknots.shop';

export function appBaseUrl(env = process.env) {
  return env.NODE_ENV === 'production' ? PRODUCTION_BASE_URL : env.APP_BASE_URL;
}
