import type { CatalogSource } from "../domain/catalog";

/**
 * Bundled TEST catalog for Gate 1. Stable ids, unique SKUs, exact decimal prices as text.
 * USD is used only because this fixture needs some currency — nothing in the domain or schema
 * assumes USD. In a later gate this is replaced by a catalog snapshot pulled from Alzabt Cloud.
 */
export const FIXTURE_CATALOG: CatalogSource = {
  currency: "USD",
  products: [
    { id: "prod-0001", sku: "COF-ESP", name: "Espresso", price: "2.50" },
    { id: "prod-0002", sku: "COF-LAT", name: "Caffè Latte", price: "3.75" },
    { id: "prod-0003", sku: "TEA-MNT", name: "Mint Tea", price: "1.99" },
    { id: "prod-0004", sku: "WTR-500", name: "Water 500ml", price: "0.75" },
    { id: "prod-0005", sku: "CRS-BTR", name: "Butter Croissant", price: "2.25" },
    { id: "prod-0006", sku: "MAN-ZTR", name: "Zaatar Manousheh", price: "1.50" },
    { id: "prod-0007", sku: "JUC-ORG", name: "Fresh Orange Juice", price: "4.10" },
    { id: "prod-0008", sku: "CKE-CHO", name: "Chocolate Cake Slice", price: "3.33" },
  ],
};
