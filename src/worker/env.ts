export interface WorkerEnv {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS?: Fetcher;
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  TOKEN_ENC_KEY?: string;
}
