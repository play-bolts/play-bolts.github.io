#!/usr/bin/env python3
"""Seed public all-time scores without manufacturing player activity.

Dry run (default): python3 scripts/seed-leaderboard.py --db /path/to/bolts.sqlite
Apply: add --apply --backup /path/to/new-private-backup.sqlite

The existing database must have completed community migration 2. This operator
utility adds leaderboard_seeds, an audit ledger of synthetic score contributions.
It never inserts players, credentials, connections, combat, or leaderboard_events;
rolling 24-hour rankings and real-user analytics therefore remain event-derived.
Backups may contain private data and are created with mode 0600. Re-running the
same seed reconciles its contribution, preserving any genuinely earned scores.
"""

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import unicodedata


SEED_ID = "launch-2026-10"
SEEDS = (
    ("bIG Dick Billy", 287, 91),
    ("GigaPatton", 263, 76),
    ("Adolf Superfan", 241, 88),
)
WHITESPACE = "\t\n\v\f\r \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
LEDGER_SQL = """
CREATE TABLE IF NOT EXISTS leaderboard_seeds(
    seed_id TEXT NOT NULL,
    name_key TEXT NOT NULL REFERENCES leaderboard_names(name_key),
    display_name TEXT NOT NULL,
    kills INTEGER NOT NULL CHECK(kills>=0),
    deaths INTEGER NOT NULL CHECK(deaths>=0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(seed_id,name_key)
)
"""


def canonical_name(name):
    """Match server/src/db.rs for public names (ASCII color numbers only)."""
    plain = re.sub(r"\^[0-9]", "", name)
    plain = "".join(c for c in plain if unicodedata.category(c) != "Cc" or c in WHITESPACE)
    display = re.sub("[" + WHITESPACE + "]+", " ", plain).strip(" ")
    key = display.lower()
    if not key or key == "unknown soldier":
        raise ValueError("Seed names must be named leaderboard identities")
    return key, display


def connect(path, *, readonly):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError("Database must be an existing regular file")
    conn = sqlite3.connect(path.as_uri() + ("?mode=ro" if readonly else "?mode=rw"),
                           uri=True, timeout=15, isolation_level=None)
    conn.execute("PRAGMA foreign_keys=ON")
    if readonly:
        conn.execute("PRAGMA query_only=ON")
    return conn


def check_integrity(conn):
    results = [row[0] for row in conn.execute("PRAGMA integrity_check")]
    if results != ["ok"]:
        raise ValueError("Database integrity check failed: " + "; ".join(results))
    if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("Database foreign-key check failed")


def check_schema(conn):
    if conn.execute("SELECT 1 FROM schema_migrations WHERE version=2").fetchone() is None:
        raise ValueError("Existing database must have completed community migration 2")
    required = {
        "leaderboard_names": {"name_key", "display_name", "first_seen", "last_seen", "kills", "deaths"},
        "leaderboard_events": {"combat_id", "role", "player_id", "name_key", "created_at"},
        "players": {"id", "is_bot"},
    }
    for table, columns in required.items():
        actual = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if not columns <= actual:
            raise ValueError(f"Existing migrated schema required: {table}")
    if ledger_exists(conn):
        required_ledger = {"seed_id", "name_key", "display_name", "kills", "deaths", "created_at", "updated_at"}
        actual = {row[1] for row in conn.execute("PRAGMA table_info(leaderboard_seeds)")}
        if not required_ledger <= actual:
            raise ValueError("Incompatible leaderboard_seeds audit ledger")


def ledger_exists(conn):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leaderboard_seeds'").fetchone() is not None


def plan(conn):
    has_ledger = ledger_exists(conn)
    rows = []
    for name, kills, deaths in SEEDS:
        key, display = canonical_name(name)
        current = conn.execute("SELECT kills,deaths FROM leaderboard_names WHERE name_key=?", (key,)).fetchone()
        previous = conn.execute("SELECT kills,deaths FROM leaderboard_seeds WHERE seed_id=? AND name_key=?",
                                (SEED_ID, key)).fetchone() if has_ledger else None
        if previous is not None and current is None:
            raise ValueError("Seed ledger refers to a missing leaderboard name")
        current = current or (0, 0)
        previous = previous or (0, 0)
        if current[0] < previous[0] or current[1] < previous[1]:
            raise ValueError("Leaderboard totals are below their audited seed contribution")
        delta = (kills - previous[0], deaths - previous[1])
        rows.append({"name": display, "name_key": key,
                     "seed_kills": kills, "seed_deaths": deaths,
                     "add_kills": delta[0], "add_deaths": delta[1],
                     "total_kills": current[0] + delta[0], "total_deaths": current[1] + delta[1]})
    return rows


def backup_database(db_path, backup_path):
    """Caller holds BEGIN IMMEDIATE, so the backup is the exact pre-write state."""
    # Keep the final component unresolved: O_EXCL must reject dangling symlinks
    # as well as symlinks pointing at existing files.
    backup_path = Path(backup_path).absolute()
    if backup_path.resolve() == Path(db_path).resolve():
        raise ValueError("Backup path must differ from database path")
    # O_EXCL rejects existing files and symlinks instead of overwriting a backup.
    fd = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    verified = False
    try:
        source = connect(db_path, readonly=True)
        destination = sqlite3.connect(backup_path)
        try:
            source.backup(destination)
            check_integrity(destination)
            verified = True
        finally:
            destination.close()
            source.close()
    finally:
        if not verified:
            backup_path.unlink(missing_ok=True)
    return backup_path


def write_seed(conn, rows, timestamp):
    conn.execute(LEDGER_SQL)
    for row in rows:
        conn.execute("""INSERT INTO leaderboard_names(name_key,display_name,first_seen,last_seen)
            VALUES(?,?,?,?) ON CONFLICT(name_key) DO NOTHING""",
            (row["name_key"], row["name"], timestamp, timestamp))
        conn.execute("UPDATE leaderboard_names SET kills=kills+?,deaths=deaths+? WHERE name_key=?",
                     (row["add_kills"], row["add_deaths"], row["name_key"]))
        conn.execute("""INSERT INTO leaderboard_seeds(seed_id,name_key,display_name,kills,deaths,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(seed_id,name_key) DO UPDATE SET
            display_name=excluded.display_name,kills=excluded.kills,deaths=excluded.deaths,
            updated_at=CASE WHEN leaderboard_seeds.kills<>excluded.kills
                OR leaderboard_seeds.deaths<>excluded.deaths
                OR leaderboard_seeds.display_name<>excluded.display_name
                THEN excluded.updated_at ELSE leaderboard_seeds.updated_at END""",
            (SEED_ID, row["name_key"], row["name"], row["seed_kills"], row["seed_deaths"], timestamp, timestamp))


def run(db_path, *, apply=False, backup=None):
    if apply and backup is None:
        raise ValueError("--apply requires --backup pointing to a new backup file")
    if not apply and backup is not None:
        raise ValueError("--backup is only used with --apply")
    conn = connect(db_path, readonly=not apply)
    try:
        # Read-only dry runs use one consistent snapshot; apply blocks competing
        # writes briefly while backup, planning, and all seed updates complete.
        conn.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
        check_schema(conn)
        check_integrity(conn)
        rows = plan(conn)
        saved_backup = None
        if apply:
            saved_backup = str(backup_database(db_path, backup))
            write_seed(conn, rows, int(time.time() * 1000))
            check_integrity(conn)
        conn.execute("COMMIT")
        return {"mode": "applied" if apply else "dry-run", "seed_id": SEED_ID,
                "backup": saved_backup, "scores": rows,
                "scope": "all-time leaderboard only; no players or activity events created"}
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, required=True, help="Existing migrated SQLite database")
    parser.add_argument("--apply", action="store_true", help="Apply the seed (default is a read-only dry run)")
    parser.add_argument("--backup", type=Path, help="New private SQLite backup file; required for --apply")
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.db, apply=args.apply, backup=args.backup), indent=2))
    except (OSError, sqlite3.Error, ValueError) as error:
        print(f"Seed failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
