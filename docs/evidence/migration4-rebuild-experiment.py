import sqlite3, os, hashlib
print("sqlite3 library version:", sqlite3.sqlite_version)
DB="/tmp/claude-1000/posexp/t2.sqlite"
if os.path.exists(DB): os.remove(DB)
c=sqlite3.connect(DB); c.isolation_level=None
for p in ("journal_mode=WAL","synchronous=FULL","foreign_keys=ON"): c.execute(f"PRAGMA {p}")

V1 = [
 "CREATE TABLE sales (id TEXT PRIMARY KEY, line_count INTEGER NOT NULL CHECK (line_count > 0)) STRICT",
 """CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales (id),
  line_no INTEGER NOT NULL CHECK (line_no > 0), product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor = quantity * unit_price_minor),
  UNIQUE (sale_id, line_no)) STRICT""",
 "CREATE INDEX sale_lines_sale_id ON sale_lines (sale_id)",
 "CREATE TRIGGER sale_lines_immutable_update BEFORE UPDATE ON sale_lines BEGIN SELECT RAISE(ABORT,'ledger: sale lines are immutable'); END",
 "CREATE TRIGGER sale_lines_immutable_delete BEFORE DELETE ON sale_lines BEGIN SELECT RAISE(ABORT,'ledger: sale lines cannot be deleted'); END",
 """CREATE TRIGGER sale_lines_closed_sale BEFORE INSERT ON sale_lines
  WHEN (SELECT count(*) FROM sale_lines WHERE sale_id = NEW.sale_id) >= (SELECT line_count FROM sales WHERE id = NEW.sale_id)
  BEGIN SELECT RAISE(ABORT,'ledger: sale already holds all of its lines'); END""",
]
for s in V1: c.execute(s)
c.execute("INSERT INTO sales VALUES ('s1',2)"); c.execute("INSERT INTO sales VALUES ('s2',1)")
c.execute("INSERT INTO sale_lines VALUES ('l1','s1',1,'صنف تجريبي ألف',1,1300,1300)")
c.execute("INSERT INTO sale_lines VALUES ('l2','s1',2,'صنف تجريبي باء',2,250,500)")
c.execute("INSERT INTO sale_lines VALUES ('l3','s2',1,'صنف تجريبي جيم',7,310,2170)")

def fp(conn):
    r=conn.execute("SELECT id,sale_id,line_no,product_name,unit_price_minor,line_total_minor FROM sale_lines ORDER BY id").fetchall()
    return hashlib.sha256(repr(r).encode()).hexdigest()[:16]
def cols(conn):
    return [x[1] for x in conn.execute("PRAGMA table_info(sale_lines)").fetchall()]
def trigs(conn):
    return sorted(x[0] for x in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall())
def idx(conn):
    return sorted(x[0] for x in conn.execute("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").fetchall())

FP0, COLS0, TRG0, IDX0 = fp(c), cols(c), trigs(c), idx(c)
print(f"\nBASELINE  fingerprint={FP0}  cols={COLS0}\n          triggers={TRG0}  indexes={IDX0}")

# The rebuild, as individual statements — the order is the design.
REBUILD = [
 "DROP TRIGGER sale_lines_immutable_update",
 "DROP TRIGGER sale_lines_immutable_delete",
 "DROP TRIGGER sale_lines_closed_sale",
 """CREATE TABLE sale_lines_new (
   id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales (id),
   line_no INTEGER NOT NULL CHECK (line_no > 0), product_name TEXT NOT NULL,
   quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
   unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
   line_total_minor INTEGER NOT NULL
     CHECK (abs(line_total_minor * 1000 - quantity_milli * unit_price_minor) <= 500),
   UNIQUE (sale_id, line_no)) STRICT""",
 """INSERT INTO sale_lines_new (id,sale_id,line_no,product_name,quantity_milli,unit_price_minor,line_total_minor)
    SELECT id,sale_id,line_no,product_name,quantity*1000,unit_price_minor,line_total_minor FROM sale_lines""",
 "DROP TABLE sale_lines",
 "ALTER TABLE sale_lines_new RENAME TO sale_lines",
 "CREATE INDEX sale_lines_sale_id ON sale_lines (sale_id)",
 "CREATE TRIGGER sale_lines_immutable_update BEFORE UPDATE ON sale_lines BEGIN SELECT RAISE(ABORT,'ledger: sale lines are immutable'); END",
 "CREATE TRIGGER sale_lines_immutable_delete BEFORE DELETE ON sale_lines BEGIN SELECT RAISE(ABORT,'ledger: sale lines cannot be deleted'); END",
 """CREATE TRIGGER sale_lines_closed_sale BEFORE INSERT ON sale_lines
    WHEN (SELECT count(*) FROM sale_lines WHERE sale_id = NEW.sale_id) >= (SELECT line_count FROM sales WHERE id = NEW.sale_id)
    BEGIN SELECT RAISE(ABORT,'ledger: sale already holds all of its lines'); END""",
]

print("\n=== T1 · CRASH SAFETY: run the whole rebuild, then ROLLBACK (a crash is a rollback) ===")
c.execute("BEGIN IMMEDIATE")
for s in REBUILD: c.execute(s)
print("  mid-transaction cols:", cols(c))
c.execute("ROLLBACK")
print(f"  after ROLLBACK  cols={cols(c)}")
print(f"  fingerprint restored: {fp(c)==FP0}   triggers restored: {trigs(c)==TRG0}   indexes restored: {idx(c)==IDX0}")
print(f"  row count: {c.execute('SELECT count(*) FROM sale_lines').fetchone()[0]}")

print("\n=== T2 · THE REAL MIGRATION: same statements, one transaction, COMMIT ===")
c.execute("BEGIN IMMEDIATE")
for s in REBUILD: c.execute(s)
print("  foreign_key_check:", c.execute("PRAGMA foreign_key_check").fetchall() or "clean")
c.execute("COMMIT")
print(f"  cols={cols(c)}")
print(f"  triggers={trigs(c)}  indexes={idx(c)}")
print(f"  HISTORY PRESERVED (every non-quantity column identical): {fp(c)==FP0}")
print("  integrity_check:", c.execute("PRAGMA integrity_check").fetchone()[0])
print("  mapped rows:", c.execute("SELECT id,quantity_milli,unit_price_minor,line_total_minor FROM sale_lines ORDER BY id").fetchall())
