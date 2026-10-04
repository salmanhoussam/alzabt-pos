/** Terminal configuration for Gate 1 (cloud-provided configuration arrives in a later gate). */
export interface TerminalConfig {
  /** Currency the terminal reports in when no sale exists yet; must match the catalog. */
  readonly currency: string;
  /** IANA zone that defines the business day (see src/domain/businessDay.ts). */
  readonly timeZone: string;
}

export const FIXTURE_TERMINAL: TerminalConfig = {
  currency: "USD",
  timeZone: "Asia/Beirut",
};
