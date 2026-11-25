import { DomainError } from "../domain/errors";
import type { EntryStateDto } from "../shared/ipcContract";
import { probeMerchantData, type CountReader, type MerchantDataProbe } from "./demoCatalog";

/** Independent UX probe: historical sales, including the old fallback, are usage. */
export interface EntryDataProbe extends MerchantDataProbe {
  readonly salesRows: number;
}

export function probeEntryData(db: CountReader): EntryDataProbe {
  const probe = probeMerchantData(db, []);
  const salesRows = Number((db.prepare("SELECT count(*) AS n FROM sales").get() as { n: bigint | number }).n);
  return { ...probe, salesRows };
}

/**
 * Read-only REAL-process routing. The probe is only a UX hint, never proof of
 * freshness or absence of merchant data, and cannot grant a ticket or session.
 * Demo activation/availability and profile selection are not implemented.
 */
export function readRealEntryState(
  readClaimed: () => boolean,
  readProbe: () => EntryDataProbe,
): EntryStateDto {
  let terminalClaimed: boolean;
  try {
    terminalClaimed = readClaimed();
    if (typeof terminalClaimed !== "boolean") throw new Error("Invalid claim state");
  } catch {
    // Do not fabricate a claimed state or expose an underlying database error.
    throw new DomainError("NOT_AVAILABLE", "Entry state is unavailable");
  }
  let firstRunEligible = false;
  if (!terminalClaimed) {
    try {
      const probe = readProbe();
      const counts = [probe.productRows, probe.parties, probe.invoices, probe.merchantSaleLines, probe.salesRows];
      firstRunEligible = counts.every((count) => Number.isSafeInteger(count) && count === 0);
    } catch {
      // Route to legacy login if the hint is unavailable.
    }
  }
  return { profile: "real", terminalClaimed, firstRunEligible, demoAvailable: false };
}

/**
 * Main-only availability hint. A true build gate alone never authorizes a
 * session or profile; the independently verified lifecycle must also be ready.
 * This helper is not wired into real startup until that lifecycle exists.
 */
export function demoAvailability(
  devGate: boolean,
  lifecycleReady: boolean,
  readRetention: () => { readonly retained:number; readonly max:5; readonly reached:boolean },
): Pick<EntryStateDto,"demoAvailable" | "demoRetention"> {
  if (devGate !== true || lifecycleReady !== true) return {demoAvailable:false};
  try {
    const r=readRetention();
    if (!Number.isSafeInteger(r.retained) || r.retained<0 || r.retained>5 ||
        r.max!==5 || r.reached!==(r.retained===5)) return {demoAvailable:false};
    return {demoAvailable:!r.reached,demoRetention:{retained:r.retained,max:5,reached:r.reached}};
  } catch {
    return {demoAvailable:false};
  }
}
