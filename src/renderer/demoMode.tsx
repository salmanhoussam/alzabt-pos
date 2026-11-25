/**
 * Whether this window is the DEMO process (from main's entry state; joint C2). PRESENTATION ONLY:
 * screens use it to leave out actions the demo policy refuses anyway (O-5: preview only — no PDF
 * save), so the operator is not offered a button that can only end in a refusal. The refusal itself
 * stays main's (X1/X2 `DEMO_RESTRICTED`); hiding a button is never the protection.
 */
import { createContext, useContext } from "react";

const DemoModeContext = createContext(false);

export const DemoModeProvider = DemoModeContext.Provider;

export function useDemoMode(): boolean {
  return useContext(DemoModeContext);
}
