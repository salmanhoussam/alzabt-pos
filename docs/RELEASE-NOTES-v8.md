# Alzabt POS — schema v8 · Operator accounts

> **Read this before installing or upgrading a shop terminal.**

## 🔴 FIRST V8 START / UPGRADE: THE OWNER MUST COMPLETE ACCOUNT SETUP IMMEDIATELY

The installation is **not finished** when the installer finishes. A freshly installed or
freshly upgraded terminal is in **OWNER SETUP REQUIRED**, and in that state:

- the shop **owner** signs in on `Cashier One` with the old PIN and sets their real name and their
  own private PIN;
- **nobody else can sign in at all** — not the second account, not with the correct old PIN. They
  cannot even reach their own setup screen;
- no selling, no invoices, no catalog work. The terminal is waiting to be claimed.

The moment the owner completes setup, the state clears **permanently** and the terminal becomes
ordinary: the second account may then set its own PIN, and normal role-based operation begins.

An independent review found an earlier build in which creating a second owner, or promoting a new
employee before they had chosen their own PIN, put the terminal back into this state and **locked
everybody out of it — including the owner**. That is now impossible: a new operator is always
created as a cashier, and somebody can only be made an owner after they have set their own PIN.

There is one way the terminal can ask for owner setup again, and it is harmless: if the owner
**resets their own PIN** on a terminal where nobody else has set theirs up yet, the terminal waits
for the owner again — and the owner is the person it waits for, so they simply set a new PIN and
carry on. Nobody is locked out and the old bundled PINs do not come back. Worth knowing only so that
it does not look like a fault if you see it.

**Why it is enforced rather than recommended.** The PINs that ship with the product are published,
so an upgraded-but-unclaimed terminal can be claimed by whoever reaches it first — and whoever
claims the owner account sets its PIN permanently, with no way to recover it inside the app. The
window is not "the first login"; it is "until somebody takes it". So the product now refuses to be
useful until the owner has claimed it.

**Do not leave a terminal in this state and walk away.** Complete owner setup before the machine
goes back to the counter.

## 🔴 REAL OPERATOR PINS: 6–8 DIGITS

Every PIN **chosen** by a person must be 6 to 8 digits: first setup, a PIN chosen after an owner
reset, and any operator created later. Four digits is refused.

Measured, not guessed: the hashes live in the shop's own database file, and **every** four-digit PIN
can be tried in about seven minutes on an ordinary machine — so an actual PIN is found in about
three and a half. Six digits makes those figures about eleven hours and six hours. It is not
unbreakable and is not claimed to be; it is enough that recovering a PIN stops being something done
over a lunch break.

The old four-digit PINs that ship with the product still **work at the door**, because that is the
credential the owner types to begin setup on upgrade day. They cannot be **chosen** as a new PIN.

## An owner-set PIN is temporary

When the owner resets someone's PIN, that PIN gets that person back to the **setup screen** — not
into the till. They choose their own final PIN, which the owner never sees. An owner who needs to
act as themselves signs in as themselves; the ledger then names the right person, which is the
entire point of having operator accounts.

## 🔴 ROLLBACK: RESTORE THE PRE-MIGRATION V7 DATABASE FIRST, THEN RUN THE V7 ROLLBACK EXE

Reinstalling the previous version **by itself is not a rollback** and will not start: a v7 build
refuses a v8 database by design, rather than half-reading it.

```
VALID ROLLBACK = RESTORE THE PRE-MIGRATION v7 DATABASE  +  RUN THE v7 EXECUTABLE
```

The snapshot is taken automatically, before the schema changes, and is never pruned:

```
%APPDATA%\Alzabt POS\backups\pre-migration-v7-to-v8-<UTC stamp>.sqlite
```

Full procedure, what a rollback costs, and what it does not touch: **`docs/ROLLBACK.md`**.

## What else changed

- Two roles, and only two: **OWNER** (the administrator) and **CASHIER** (the employee). Owner-only
  actions are refused by the application itself, not merely hidden from the screen.
- A role change or a deactivation takes effect on that person's **very next action** — no logout, no
  restart.
- The audit trail now records **which role** performed each action. Rows written by earlier versions
  keep saying "unspecified", truthfully, and are never rewritten.
- An operator is **deactivated, never deleted**, because past sales name them.
- Every sale and void keeps the operator's name **as it was that day**. Renaming someone later
  changes no past record.
