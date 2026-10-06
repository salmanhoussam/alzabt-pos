import sqlite3
print("sqlite", sqlite3.sqlite_version)
c=sqlite3.connect(":memory:"); c.isolation_level=None
print("=== is / integer division on integers in SQLite? ===")
for a,b in [(7,2),(100500,1000),(99567,1000),(105561,1000),(1,1000)]:
    print(f"  {a} / {b} =", c.execute(f"SELECT {a}/{b}").fetchone()[0], " typeof:", c.execute(f"SELECT typeof({a}/{b})").fetchone()[0])

print("\n=== EXACT round-half-up CHECK vs the bounded CHECK ===")
c.execute("""CREATE TABLE exact (id TEXT PRIMARY KEY, q INTEGER NOT NULL, p INTEGER NOT NULL, t INTEGER NOT NULL,
  CHECK (t = (q * p + 500) / 1000)) STRICT""")
c.execute("""CREATE TABLE bounded (id TEXT PRIMARY KEY, q INTEGER NOT NULL, p INTEGER NOT NULL, t INTEGER NOT NULL,
  CHECK (abs(t*1000 - q*p) <= 500)) STRICT""")
def halfup(q,p): return (q*p + 500)//1000
cases = [
  ("3 pieces x 4.00",      3000, 400),
  ("34 kg x 2.60",        34000, 260),
  ("2.5 m x 3.10",         2500, 310),
  ("0.333 kg x 3.17",       333, 317),
  ("0.500 kg x 2.01 (TIE)",  500, 201),
  ("0.001 kg x 0.01",         1,   1),
]
for label,q,p in cases:
    want = halfup(q,p)
    row=[]
    for tbl in ("exact","bounded"):
        acc=[]
        for t in range(max(0,want-2), want+3):
            try:
                c.execute(f"INSERT INTO {tbl} VALUES (?,?,?,?)", (f"{tbl}{q}{p}{t}",q,p,t)); acc.append(t)
            except Exception: pass
        row.append(acc)
    print(f"  {label:26} q*p={q*p:>9}  round-half-up={want:>4}   exact accepts {row[0]}   bounded accepts {row[1]}")
print("\n  ⇒ the EXACT form admits exactly one total in every case, the tie included.")
