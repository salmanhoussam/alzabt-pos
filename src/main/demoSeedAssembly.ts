/**
 * Main-only, not wired into startup or IPC. The token can only be issued after
 * the synthetic account ceremony and is claimed against the exact Db object.
 * Seed writes expose no service graph. After successful verification only,
 * finish revokes the writer and creates a fresh normal authenticated graph.
 * Parent trust and Windows reparse substitution remain separate concerns.
 */
import { emptyCatalog } from "../domain/catalog";
import { FIXTURE_TERMINAL } from "../fixtures/terminal";
import type { Db } from "../persistence/db";
import { claimSyntheticSeedAuthority, type SyntheticSeedAuthority } from "./demoSeedAccounts";
import { createLedgerServices } from "./ledgerServices";
import { verifyDemoSeedReadback } from "./demoSeedReadback";
import { CatalogRepository } from "../persistence/catalogRepository";
import { startupCatalog } from "../application/posService";
import { BOOTSTRAP_OWNER_ID } from "../persistence/operatorRepository";
import { createSyntheticLogoVault } from "./demoLogoVault";

export function createSyntheticSeedAssembly(authority: SyntheticSeedAuthority, db: Db) {
  const guard = claimSyntheticSeedAuthority(authority, db);
  try {
    guard.verifyOwner();
    const catalog = emptyCatalog(FIXTURE_TERMINAL.currency);
    const services = createLedgerServices(db, {
      catalog, fallbackCatalog: catalog, appVersion: "synthetic-demo", seedActor: guard,
      logoVault: { freeze: () => null },
      isCurrentLedger: () => db.open,
      assertOpen: () => { if (!db.open) throw new Error("ledger is not open"); },
      audit: () => {},
    });
    if (services.service.currentCashier() !== null || services.service.currentRole() !== null) {
      throw new Error("unexpected session");
    }
    // Never expose the service graph or guard. A failed operation consumes the
    // authority and closes this synthetic connection; its slot is retained.
    let state: "seeding" | "finished" | "failed" = "seeding";
    const cancel = (): void => {
      if (state !== "seeding") return;
      state = "failed";
      guard.revoke();
      if (db.open) db.close();
    };
    const perform = <T>(operation: () => T): T => {
      try {
        if (state !== "seeding") throw new Error("seed capability unavailable");
        guard.verifyOwner();
        return operation();
      } catch {
        cancel();
        throw new Error("Synthetic demo seed operation failed.");
      }
    };
    const service = services.service;
    const invoices = services.invoices;
    return Object.freeze({
      importCatalogCsv: (...args: Parameters<typeof service.seedImportCatalogCsv>) =>
        perform(() => {
          const result = service.seedImportCatalogCsv(...args);
          if (result.status !== "imported" || result.rowCount !== 22 || result.inserted !== 22 ||
              result.updated !== 0 || result.unchanged !== 0 || result.deactivated !== 0) {
            throw new Error("Unexpected seed catalog result.");
          }
          return result;
        }),
      updateProduct: (...args: Parameters<typeof service.seedUpdateProduct>) =>
        perform(() => service.seedUpdateProduct(...args)),
      createCategory: (...args: Parameters<typeof service.seedCreateCategory>) =>
        perform(() => service.seedCreateCategory(...args)),
      setProductPrimaryImage: (...args: Parameters<typeof service.seedSetProductPrimaryImage>) =>
        perform(() => service.seedSetProductPrimaryImage(...args)),
      saveCompanyProfile: (...args: Parameters<typeof invoices.seedSaveCompanyProfile>) =>
        perform(() => invoices.seedSaveCompanyProfile(...args)),
      /**
       * Main-only, not IPC. Call only after a trusted adapter loaded pinned
       * reviewed assets. Verification uses the SAME reserved Db and profile.
       */
      finish: (input: Parameters<typeof verifyDemoSeedReadback>[1], ownerPin: string) => {
        if (state !== "seeding") throw new Error("seed capability unavailable");
        try {
          guard.verifyOwner();
          verifyDemoSeedReadback(db, input);
          guard.verifyOwner();
          guard.revoke();
          state = "finished";
          const fallback = emptyCatalog(FIXTURE_TERMINAL.currency);
          const current = startupCatalog(new CatalogRepository(db), fallback, FIXTURE_TERMINAL.currency);
          if (current.origin !== "local" || current.catalog.products.length !== 22) throw new Error("catalog unavailable");
          const normal = createLedgerServices(db, {
            catalog: current.catalog, fallbackCatalog: fallback, appVersion: "synthetic-demo",
            logoVault: createSyntheticLogoVault(db),
            isCurrentLedger: () => db.open,
            assertOpen: () => { if (!db.open) throw new Error("ledger is not open"); },
            audit: () => {},
          });
          const result = normal.service.login(BOOTSTRAP_OWNER_ID, ownerPin);
          if (result.kind !== "session" || result.session.id !== BOOTSTRAP_OWNER_ID ||
              result.session.role !== "owner" || normal.service.currentRole() !== "owner") {
            normal.service.logout();
            throw new Error("synthetic owner login failed");
          }
          return normal;
        } catch {
          state = "failed";
          guard.revoke();
          if (db.open) db.close();
          throw new Error("Synthetic demo seed verification failed.");
        }
      },
      cancel,
    });
  } catch {
    guard.revoke();
    if (db.open) db.close();
    throw new Error("Synthetic demo assembly unavailable.");
  }
}
