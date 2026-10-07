import sqlite3, os
print("=== T6 (redone) · ordering trap, with TWO lines on ONE sale — as real data has ===")
for label, create_trigger_first in (("trigger BEFORE copy", True), ("trigger AFTER copy", False)):
    DB=f"/tmp/claude-1000/posexp/t6_{create_trigger_first}.sqlite"
    if os.path.exists(DB): os.remove(DB)
    d=sqlite3.connect(DB); d.isolation_level=None; d.execute("PRAGMA foreign_keys=ON")
    d.execute("CREATE TABLE sales (id TEXT PRIMARY KEY, line_count INTEGER NOT NULL) STRICT")
    d.execute("CREATE TABLE sale_lines (id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), line_no INTEGER NOT NULL, quantity INTEGER NOT NULL) STRICT")
    d.execute("INSERT INTO sales VALUES ('s1',2)")           # ONE sale declaring TWO lines
    d.execute("INSERT INTO sale_lines VALUES ('l1','s1',1,5)")
    d.execute("INSERT INTO sale_lines VALUES ('l2','s1',2,7)")
    d.execute("CREATE TABLE sale_lines_new (id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), line_no INTEGER NOT NULL, quantity_milli INTEGER NOT NULL) STRICT")
    TRG = """CREATE TRIGGER t_closed BEFORE INSERT ON sale_lines_new
      WHEN (SELECT count(*) FROM sale_lines_new WHERE sale_id = NEW.sale_id) >= (SELECT line_count FROM sales WHERE id = NEW.sale_id)
      BEGIN SELECT RAISE(ABORT,'ledger: sale already holds all of its lines'); END"""
    COPY = "INSERT INTO sale_lines_new SELECT id,sale_id,line_no,quantity*1000 FROM sale_lines"
    try:
        if create_trigger_first: d.execute(TRG)
        d.execute(COPY)
        if not create_trigger_first: d.execute(TRG)
        n=d.execute("SELECT count(*) FROM sale_lines_new").fetchone()[0]
        print(f"  {label:22}  copy OK, {n} rows copied")
    except Exception as e:
        n=d.execute("SELECT count(*) FROM sale_lines_new").fetchone()[0]
        print(f"  {label:22}  ABORTED -> {e}   (rows left: {n})")
    d.close()

print("\n=== T8 · the tie case of the bounded CHECK (qty*price ending in exactly 500) ===")
e=sqlite3.connect(":memory:"); e.isolation_level=None
e.execute("""CREATE TABLE l (id TEXT PRIMARY KEY, q INTEGER NOT NULL, p INTEGER NOT NULL, t INTEGER NOT NULL,
  CHECK (abs(t*1000 - q*p) <= 500)) STRICT""")
# q=500 (0.500), p=201  -> 500*201 = 100500 -> /1000 = 100.5 exactly: both 100 and 101 are 500 away
for tot in (100,101,102,99):
    try: e.execute("INSERT INTO l VALUES (?,500,201,?)",(f"t{tot}",tot)); print(f"  0.500 x 2.01 -> {tot}  ACCEPTED")
    except Exception as ex: print(f"  0.500 x 2.01 -> {tot}  REJECTED")
print("  -> an exact .5 tie admits TWO totals; the app's round-half-up rule picks one. Any other value is refused.")

print("\n=== T9 · integer overflow headroom for the check arithmetic ===")
f=sqlite3.connect(":memory:"); f.isolation_level=None
MAXQ=9999*1000          # the current MAX_QUANTITY, scaled
MAXP=100_000_000        # a 1,000,000.00 unit price — far beyond any shop
print(f"  qty_milli max {MAXQ:,} x price {MAXP:,} = {MAXQ*MAXP:,}")
print(f"  int64 ceiling                        = {2**63-1:,}")
print(f"  headroom factor                      = {(2**63-1)//(MAXQ*MAXP):,}x")
