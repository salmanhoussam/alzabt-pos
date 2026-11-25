/** Internal trusted composition port. This is never accepted from renderer or IPC. */
export interface SeedActor {
  verifyOwner(): { readonly id: string; readonly name: string; readonly role: "owner" };
}
