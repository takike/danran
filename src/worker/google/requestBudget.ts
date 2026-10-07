/** Thrown before a Google fetch when a request-scoped external-call budget is exhausted. */
export class GoogleRequestBudgetExceededError extends Error {
  constructor() {
    super('Google external request budget exhausted');
    this.name = 'GoogleRequestBudgetExceededError';
  }
}

export interface GoogleRequestContext {
  fetcher: typeof fetch;
  accessToken(forceRefresh?: boolean, rejectedToken?: string): Promise<string>;
}

export interface GoogleCalendarClientOptions {
  /** Reuse a short-lived access token only for calls made by this client instance. */
  reuseAccessToken?: boolean;
  /** Maximum total OAuth and Calendar fetches made by this client instance. */
  maxExternalRequests?: number;
}
