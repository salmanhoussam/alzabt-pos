/**
 * DEMO-FALLBACK (RISK-24, owner decision D-DF1 = option A, 2026-11-06).
 *
 * Until this module, a terminal with no active product in the shop currency silently served the
 * bundled sample café catalog (Espresso 2.50 …), unmarked, and recorded its sales as genuine. The
 * owner's rule is now:
 *
 *   - MERCHANT MODE (the default, no switch): no active local product ⇒ an EMPTY catalog. The till
 *     shows an empty state; a sale of a sample product is refused (`UNKNOWN_PRODUCT`) and writes
 *     nothing.
 *   - DEMO MODE: only with the explicit environment switch `ALZABT_POS_DEMO_CATALOG=1`, AND only on a
 *     ledger that holds no merchant data at all. A switch set on a real shop's profile is IGNORED —
 *     a demo can never be turned on inside a merchant's database. When active, Sell shows a
 *     permanent warning.
 *
 * There is deliberately no setting in Tools: the owner chose an environment switch for tests and
 * sales demos only. Nothing here touches the network, and nothing rewrites past sales.
 */

export const DEMO_CATALOG_ENV = "ALZABT_POS_DEMO_CATALOG";

/** The switch is on only for the exact value "1" — never "true", "yes" or an empty string. */
export function demoCatalogRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[DEMO_CATALOG_ENV] === "1";
}

/**
 * What counts as merchant data. ANY local product row (active or not), ANY customer / supplier, ANY
 * invoice, and ANY historical sale line of a product that is NOT one of the bundled sample's ids — a
 * ledger with real sales history is a shop, even if its product rows were never kept (e.g. one
 * brought forward from an older build). A demo profile's OWN sample sales are not counted, so a
 * relaunched demo (crash recovery, upgrade from a demo-era build) stays a demo.
 */
export interface MerchantDataProbe {
  readonly productRows: number;
  readonly parties: number;
  readonly invoices: number;
  readonly merchantSaleLines: number;
}

export type DemoCatalogDecision =
  | { readonly mode: "merchant"; readonly demoRefused: false }
  | { readonly mode: "merchant"; readonly demoRefused: true; readonly reason: "merchant-data" }
  | { readonly mode: "demo" };

export function decideDemoCatalog(requested: boolean, probe: MerchantDataProbe): DemoCatalogDecision {
  if (!requested) return { mode: "merchant", demoRefused: false };
  const hasMerchantData = probe.productRows > 0 || probe.parties > 0 || probe.invoices > 0 || probe.merchantSaleLines > 0;
  return hasMerchantData ? { mode: "merchant", demoRefused: true, reason: "merchant-data" } : { mode: "demo" };
}

/** A minimal read port so the probe is testable without Electron. Counts only; reads nothing else. */
export interface CountReader {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

const COUNT_SQL = {
  productRows: "SELECT count(*) AS n FROM catalog_products",
  parties: "SELECT count(*) AS n FROM parties",
  invoices: "SELECT count(*) AS n FROM invoices",
} as const;

/**
 * Reads the counts. Every table exists at schema ≥ 12, which is the floor of this build's ledger.
 * `sampleProductIds` are the bundled sample's ids; any OTHER product id on a sale line is a real sale.
 */
export function probeMerchantData(db: CountReader, sampleProductIds: ReadonlyArray<string>): MerchantDataProbe {
  const count = (sql: string): number => Number((db.prepare(sql).get() as { n: bigint | number }).n);
  const ids = JSON.stringify([...sampleProductIds]);
  const merchantSaleLines = Number(
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM sale_lines WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT value FROM json_each(?))",
        )
        .get(ids) as { n: bigint | number }
    ).n,
  );
  return {
    productRows: count(COUNT_SQL.productRows),
    parties: count(COUNT_SQL.parties),
    invoices: count(COUNT_SQL.invoices),
    merchantSaleLines,
  };
}
