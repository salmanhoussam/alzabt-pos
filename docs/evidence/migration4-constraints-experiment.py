import sqlite3
c=sqlite3.connect("/tmp/claude-1000/posexp/t2.sqlite"); c.isolation_level=None  # DB from migration4-rebuild-experiment.py
c.execute("PRAGMA foreign_keys=ON")
def t(label, sql, args=()):
    try:
        c.execute(sql,args); print(f"  ACCEPTED  {label}")
    except Exception as e: print(f"  REJECTED  {label}  ->  {e}")

print("=== T3 · the bounded CHECK: abs(line_total*1000 - qty_milli*price) <= 500 ===")
c.execute("INSERT INTO sales VALUES ('s3',9)")
# 2.5 kg at 260 minor  -> 2500*260/1000 = 650 exactly
t("2.500 kg x 3.10  -> 775 (exact)",            "INSERT INTO sale_lines VALUES ('a1','s3',1,'kg',2500,310,775)")
# 0.333 kg at 299 -> 333*299/1000 = 99.567 -> round = 100
t("0.333 kg x 3.17  -> 106 (correctly rounded)","INSERT INTO sale_lines VALUES ('a2','s3',2,'kg',333,317,106)")
t("0.333 kg x 3.17  -> 105 (one minor low)",    "INSERT INTO sale_lines VALUES ('a3','s3',3,'kg',333,317,105)")
t("0.333 kg x 3.17  -> 107 (one minor high)",   "INSERT INTO sale_lines VALUES ('a4','s3',4,'kg',333,317,107)")
t("0.333 kg x 3.17  -> 0   (not charged)",      "INSERT INTO sale_lines VALUES ('a5','s3',5,'kg',333,317,0)")
print("  -> the check admits ONLY the correctly-rounded total; see the tie case in the ordering/ties script.")

print("\n=== T4 · WHOLE-UNIT lines are still forced to EXACT equality (the old invariant) ===")
t("3 pieces x 4.00 -> 1200 (exact)",            "INSERT INTO sale_lines VALUES ('b1','s3',6,'pc',3000,400,1200)")
t("3 pieces x 4.00 -> 1201 (off by one minor)", "INSERT INTO sale_lines VALUES ('b2','s3',7,'pc',3000,400,1201)")
t("3 pieces x 4.00 -> 1199 (off by one minor)", "INSERT INTO sale_lines VALUES ('b3','s3',8,'pc',3000,400,1199)")

print("\n=== T5 · immutability still bites after the rebuild ===")
t("UPDATE a sale line",   "UPDATE sale_lines SET quantity_milli = 9 WHERE id='l1'")
t("DELETE a sale line",   "DELETE FROM sale_lines WHERE id='l1'")
t("zero/negative qty",    "INSERT INTO sale_lines VALUES ('c1','s3',9,'x',0,100,0)")
t("line beyond line_count (s2 declares 1, already has 1)", "INSERT INTO sale_lines VALUES ('c2','s2',2,'x',1000,100,100)")
t("line for a sale that does not exist (FK)", "INSERT INTO sale_lines VALUES ('c3','nope',1,'x',1000,100,100)")

# T6 (one line per sale) was WITHDRAWN as too weak to exercise the closed_sale trigger.
# The corrected test, with two lines on one sale, lives in
# migration4-ordering-and-ties-experiment.py — and it reverses the conclusion.

print("\n=== T7 · does DROP TABLE fire the immutable_delete trigger? ===")
e=sqlite3.connect(":memory:"); e.isolation_level=None
e.execute("CREATE TABLE x (id TEXT) STRICT"); e.execute("INSERT INTO x VALUES ('r1')")
e.execute("CREATE TRIGGER x_del BEFORE DELETE ON x BEGIN SELECT RAISE(ABORT,'cannot be deleted'); END")
try:
    e.execute("DROP TABLE x"); print("  DROP TABLE SUCCEEDED — a BEFORE DELETE trigger does NOT fire on DROP")
except Exception as ex: print(f"  DROP TABLE blocked -> {ex}")
