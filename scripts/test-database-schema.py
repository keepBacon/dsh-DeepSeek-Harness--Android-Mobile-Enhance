#!/usr/bin/env python3
"""Executable SQLite contract tests for the Android native database schema.

Uses the SQL text extracted from DshDatabaseStore.kt (not a duplicate SQL
fixture), catching constraint and cascade mistakes before an APK build.
Android authorization and Keystore behavior still require device tests.
"""
from pathlib import Path
import re
import sqlite3

root = Path(__file__).resolve().parent.parent
src = (root / "app/src/main/java/com/dshmobile/shell/DshDatabaseStore.kt").read_text()
ddls = re.findall(r'db\.execSQL\("""(.*?)"""\.trimIndent\(\)\)', src, re.S)
assert len(ddls) == 2, f"Expected two SQL table definitions, got {len(ddls)}"
indexes = re.findall(r'db\.execSQL\("(CREATE INDEX [^"]+)"\)', src)
assert len(indexes) == 2
conn = sqlite3.connect(":memory:")
conn.execute("PRAGMA foreign_keys=ON")
for sql in ddls + indexes:
    conn.execute(sql)
now = 1
conn.execute(
    """INSERT INTO partitions(id,title,description,importance,access_mode,
       allow_model_read,require_write_confirmation,is_default,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)""",
    ("long_term_memory", "长期记忆", "", "high", "global", 0, 1, 1, now, now)
)
conn.execute(
    """INSERT INTO entries(id,partition_id,kind,title,text_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)""",
    ("t1", "long_term_memory", "text", "policy", "retain permission", now, now)
)
conn.execute(
    """INSERT INTO entries(id,partition_id,kind,title,external_ref,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)""",
    ("f1", "long_term_memory", "file", "file", "attachment:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now, now)
)
conn.execute(
    """INSERT INTO entries(id,partition_id,kind,title,external_ref,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)""",
    ("s1", "long_term_memory", "special", "token", "keystore:example", now, now)
)

def rejected(sql, values):
    try:
        with conn:
            conn.execute(sql, values)
    except sqlite3.IntegrityError:
        return
    raise AssertionError(f"Database accepted invalid row: {sql} {values}")

rejected("INSERT INTO entries(id,partition_id,kind,title,text_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
         ("bad", "unknown_partition", "text", "invalid", "x", now, now))
rejected("INSERT INTO entries(id,partition_id,kind,title,text_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
         ("bad", "long_term_memory", "special", "invalid", "plaintext-secret", now, now))
rejected("INSERT INTO entries(id,partition_id,kind,title,external_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
         ("bad", "long_term_memory", "text", "invalid", "wrong", now, now))
rejected("UPDATE partitions SET access_mode=? WHERE id=?",
         ("invalid_mode", "long_term_memory"))
rejected("UPDATE partitions SET allow_model_read=? WHERE id=?",
         (8, "long_term_memory"))
rejected("UPDATE partitions SET importance=? WHERE id=?",
         ("top-secret", "long_term_memory"))
conn.execute(
    """INSERT INTO partitions(id,title,description,importance,access_mode,
       access_id,allow_model_read,require_write_confirmation,is_default,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
    ("workspace_partition", "Workspace", "", "normal", "workspace", "workspace-1", 1, 1, 0, now, now)
)
conn.execute(
    """INSERT INTO entries(id,partition_id,kind,title,text_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)""",
    ("child", "workspace_partition", "text", "text", "hello", now, now)
)
conn.execute("DELETE FROM partitions WHERE id=?", ("workspace_partition",))
assert conn.execute("SELECT count(*) FROM entries WHERE id='child'").fetchone()[0] == 0
assert conn.execute("SELECT count(*) FROM entries WHERE partition_id='long_term_memory'").fetchone()[0] == 3
assert conn.execute("SELECT allow_model_read FROM partitions WHERE id='long_term_memory'").fetchone()[0] == 0
print("[DSH] database SQLite schema/foreign-key/access constraint tests: OK")
