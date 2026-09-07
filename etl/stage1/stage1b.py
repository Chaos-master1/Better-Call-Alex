import sqlite3, time, sys
def log(m): print(m, flush=True)
def count_all(path, label):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=120)
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")
                if not r[0].startswith("sqlite_") and r[0] != "_merge_shards"]
    out = {}
    for t in tables:
        try:
            out[t] = db.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        except Exception as e:
            out[t] = f"ERR {e.__class__.__name__}"
    db.close()
    return out
log("=== stage 1b differential row counts ===")
new = count_all("data/corpus.new.sqlite", "new")
log("NEW: " + str(new))
old = count_all("data/corpus.sqlite", "old")
log("OLD: " + str(old))
all_keys = sorted(set(new.keys()) | set(old.keys()))
log("TABLE | OLD | NEW | DELTA")
ok = True
for t in all_keys:
    n = new.get(t, "MISSING")
    o = old.get(t, "MISSING")
    if isinstance(n, int) and isinstance(o, int):
        d = n - o
        flag = "" if d == 0 else (" (+)" if d > 0 else " (-)")
        if t == "opinions" and d != 0: ok = False
    else:
        flag = " (mixed)"
    log(f"  {t:30s} | {str(o):>12s} | {str(n):>12s} | {flag}")
log("VERDICT: " + ("opinions match (deterministic from raw CSV)" if ok else "opinions count drifted — investigate"))
log("=== stage 1b done ===")
