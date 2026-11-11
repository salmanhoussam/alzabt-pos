# KNOWN ISSUE — frozen-logo backup gap

> **Status: RECORDED, NOT FIXED. No design approved.**
> Found 2026-10-10 while measuring Product Photo feasibility, not while chasing it. Recorded
> separately at Salman's instruction, because it is **not** the PDF logo-rendering defect fixed in
> PR #12 and must not be fixed inside it.

## Not the same bug as PR #12

| | PR #12's defect (FIXED) | This issue (OPEN) |
| :--- | :--- | :--- |
| What failed | The printed PDF embedded no logo at all | The logo file is absent after restoring a backup elsewhere |
| Why | The print document was loaded as a `data:` URL — an opaque origin — so Chromium refused the `file://` image | Backups contain the database and **no files** |
| Scope | Every invoice printed from the installed build | Only a database restored onto another installation |
| State | Fixed in `d771a2d`, proven on the installed app | Untouched, live today |

They are easy to conflate because both end in "the invoice has no logo", so the distinction is
written down rather than remembered.

## The measurement

`src/persistence/backup.ts` makes **every** backup with `VACUUM INTO` — the pre-migration snapshot,
the daily snapshot, and the operator's own export:

```
db.prepare("VACUUM INTO ?").run(partial)          backup.ts:103
```

and `exportBackup` (`src/main/main.ts:371-385`) writes **one `.sqlite` file**:

```
defaultPath: join(app.getPath("documents"), `alzabt-pos-backup-${stampNow()}.sqlite`)
filters: [{ name: "Alzabt POS backup", extensions: ["sqlite"] }]
snap = snapshotDatabase(db, path)
```

There is no archive, no folder copy, no asset sweep anywhere in the backup path.

Meanwhile the frozen logo assets live **outside** the database:

```
userData/branding/invoice-logo.png        the shop's CURRENT logo
userData/branding/frozen/<sha256>.png     the content-addressed copy an ISSUED invoice points at
```

and `issuer_snapshot_json.logo_asset` stores only the **file name** of that copy, which
`invoiceLogoUrl()` resolves against the frozen directory at render time.

## The consequence, stated exactly

Restoring a database backup onto **another installation** — a replacement PC, a rebuilt machine,
a second terminal — produces a ledger whose finalized invoices name frozen logo assets that are not
present. `logoPathFor()` returns `null` for a file that does not exist, so those invoices reprint
**without their logo**, silently and with no error.

So the freeze guarantee is real **within one installation** and does not survive a restore. That is
narrower than "the freeze is broken" and wider than "nothing is wrong":

- ✅ Replacing or deleting the shop's current logo cannot alter an already-issued invoice. Proven on
  the installed app by `e2e/invoice-logo.mjs` — the frozen asset is still logo one after a rebrand,
  and still embeds after a restart.
- ❌ A database restored where the asset files are absent loses those logos for good. The bytes
  existed in exactly one place and backups never contained it.

## What is NOT claimed

- Not reproduced end to end. No restore-onto-a-clean-machine test has been run; the conclusion is
  read off the backup implementation and the resolver, both quoted above. Calling it confirmed would
  overstate what was measured.
- No data loss has been observed in the field. The shop has one installation.
- Nothing is said here about whether this should be fixed by making backups an archive, by moving
  image bytes into the database, or by accepting it. That is a design decision.

## Why it is being recorded now rather than fixed

It shares a root cause with the Product Photo question
(`docs/plans/product-master-category-and-photo-feasibility.md`): **a managed file beside the database
is not in any backup.** Whichever way that is settled for photos settles this too, and fixing it
first — inside a field-fix PR, under installer pressure — would be the worse order.

If backups ever become an archive that includes `userData/branding/`, this closes as a side effect,
and that is the cheapest moment to close it.

## Open questions, Salman's

1. Is the loss acceptable for now, given one installation and a current logo that can simply be
   re-chosen after a restore? (The CURRENT logo is re-selectable in two clicks; the FROZEN copies of
   past invoices are not.)
2. Should backup/export become an archive (database + `branding/`), which also answers Product
   Photo option B?
3. Or should a logo be frozen **into the database** as bytes at finalization, making the snapshot
   self-sufficient — a schema change, and a bigger one than it looks, since `issuer_snapshot_json`
   is inside an immutable row.
