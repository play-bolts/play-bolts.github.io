import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("seed_leaderboard", ROOT / "scripts/seed-leaderboard.py")
seed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seed)


class LeaderboardSeedTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "bolts.sqlite"
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)
        # Avoid depending on SQLite's recent unixepoch('subsec') support in the
        # Python runtime: the real migration's wall-clock value is irrelevant.
        schema = (ROOT / "server/schema.sql").read_text().replace("unixepoch('subsec')*1000", "1")
        self.conn.executescript(schema)
        self.conn.execute("INSERT INTO schema_migrations VALUES(2,1)")
        self.conn.execute("INSERT INTO players(id,credential_hash,display_name,created_at,last_seen) VALUES('real-human','test-hash','Actual Human',1,1)")
        self.conn.execute("INSERT INTO events(id,event_type,at) VALUES('start','server_start',1)")
        self.conn.commit()

    def backup(self, name="backup.sqlite"):
        return self.path.parent / name

    def table_counts(self):
        tables = [r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN('leaderboard_names','leaderboard_seeds','sqlite_sequence')")]
        return {table: self.conn.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in tables}

    def test_dry_run_is_read_only_and_does_not_create_ledger_or_backup(self):
        before = list(self.conn.iterdump())
        result = seed.run(self.path)
        self.assertEqual(result["mode"], "dry-run")
        self.assertEqual([r["total_kills"] for r in result["scores"]], [287, 263, 241])
        self.assertEqual(list(self.conn.iterdump()), before)
        self.assertFalse(seed.ledger_exists(self.conn))
        self.assertFalse(self.backup().exists())

    def test_seed_records_only_aggregates_and_ledger_with_private_online_backup(self):
        unchanged = self.table_counts()
        before = list(self.conn.iterdump())
        # The source connection remains open and its newest records are in WAL;
        # copying only the main database file would lose these records.
        self.assertTrue(Path(str(self.path) + "-wal").exists())
        result = seed.run(self.path, apply=True, backup=self.backup())
        self.assertEqual(result["mode"], "applied")
        self.assertEqual(self.table_counts(), unchanged)
        self.assertEqual(self.conn.execute("SELECT display_name,kills,deaths FROM leaderboard_names ORDER BY kills DESC").fetchall(), list(seed.SEEDS))
        self.assertEqual(self.conn.execute("SELECT count(*) FROM leaderboard_seeds").fetchone()[0], 3)
        self.assertEqual(self.backup().stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(self.backup()) as backup:
            self.assertEqual(list(backup.iterdump()), before)
            self.assertEqual(backup.execute("PRAGMA integrity_check").fetchall(), [("ok",)])

    def test_repeat_is_idempotent_and_preserves_existing_and_subsequent_earned_scores(self):
        self.conn.execute("INSERT INTO leaderboard_names VALUES('gigapatton','GIGAPATTON',10,20,12,5)")
        self.conn.commit()
        seed.run(self.path, apply=True, backup=self.backup())
        self.conn.execute("UPDATE leaderboard_names SET kills=kills+7,deaths=deaths+2,last_seen=30 WHERE name_key='gigapatton'")
        self.conn.commit()
        before = list(self.conn.iterdump())
        result = seed.run(self.path, apply=True, backup=self.backup("second.sqlite"))
        self.assertTrue(all(row["add_kills"] == row["add_deaths"] == 0 for row in result["scores"]))
        self.assertEqual(list(self.conn.iterdump()), before)
        self.assertEqual(self.conn.execute("SELECT display_name,kills,deaths,first_seen,last_seen FROM leaderboard_names WHERE name_key='gigapatton'").fetchone(), ("GIGAPATTON", 282, 83, 10, 30))

    def test_failure_mid_write_rolls_back_scores_and_ledger_but_keeps_valid_backup(self):
        self.conn.execute("""CREATE TRIGGER refuse_second_seed BEFORE INSERT ON leaderboard_names
            WHEN NEW.name_key='gigapatton' BEGIN SELECT RAISE(ABORT,'simulated refusal'); END""")
        self.conn.commit()
        before = list(self.conn.iterdump())
        with self.assertRaisesRegex(sqlite3.IntegrityError, "simulated refusal"):
            seed.run(self.path, apply=True, backup=self.backup())
        self.assertEqual(list(self.conn.iterdump()), before)
        self.assertFalse(seed.ledger_exists(self.conn))
        with sqlite3.connect(self.backup()) as backup:
            self.assertEqual(list(backup.iterdump()), before)

    def test_missing_or_unmigrated_database_is_rejected_without_creation(self):
        missing = self.path.parent / "missing.sqlite"
        with self.assertRaises(FileNotFoundError):
            seed.run(missing)
        with self.assertRaises(FileNotFoundError):
            seed.run(missing, apply=True, backup=self.backup())
        self.assertFalse(missing.exists())
        self.conn.execute("DELETE FROM schema_migrations WHERE version=2")
        self.conn.commit()
        with self.assertRaisesRegex(ValueError, "migration 2"):
            seed.run(self.path, apply=True, backup=self.backup())
        self.assertFalse(self.backup().exists())
        self.assertFalse(seed.ledger_exists(self.conn))

    def test_apply_requires_new_backup_and_refuses_existing_or_symlink_targets(self):
        with self.assertRaisesRegex(ValueError, "requires --backup"):
            seed.run(self.path, apply=True)
        with self.assertRaisesRegex(ValueError, "only used with --apply"):
            seed.run(self.path, backup=self.backup())
        self.backup().write_bytes(b"preserve backup")
        with self.assertRaises(FileExistsError):
            seed.run(self.path, apply=True, backup=self.backup())
        self.assertEqual(self.backup().read_bytes(), b"preserve backup")
        link = self.backup("symlink.sqlite")
        link.symlink_to(self.backup())
        with self.assertRaises(FileExistsError):
            seed.run(self.path, apply=True, backup=link)
        dangling = self.backup("dangling.sqlite")
        dangling_target = self.backup("never-created.sqlite")
        dangling.symlink_to(dangling_target)
        with self.assertRaises(FileExistsError):
            seed.run(self.path, apply=True, backup=dangling)
        self.assertFalse(dangling_target.exists())
        self.assertEqual(self.conn.execute("SELECT count(*) FROM leaderboard_names").fetchone()[0], 0)

    def test_audited_contribution_cannot_exceed_existing_total(self):
        seed.run(self.path, apply=True, backup=self.backup())
        self.conn.execute("UPDATE leaderboard_names SET kills=0 WHERE name_key='gigapatton'")
        self.conn.commit()
        with self.assertRaisesRegex(ValueError, "below their audited seed"):
            seed.run(self.path, apply=True, backup=self.backup("bad-state.sqlite"))
        self.assertFalse(self.backup("bad-state.sqlite").exists())

    def test_seed_adjustment_preserves_earned_portion(self):
        from unittest.mock import patch
        seed.run(self.path, apply=True, backup=self.backup())
        self.conn.execute("UPDATE leaderboard_names SET kills=kills+4,deaths=deaths+2 WHERE name_key='gigapatton'")
        self.conn.commit()
        with patch.object(seed, "SEEDS", (("GigaPatton", 250, 70),)):
            seed.run(self.path, apply=True, backup=self.backup("adjusted.sqlite"))
        self.assertEqual(self.conn.execute("SELECT kills,deaths FROM leaderboard_names WHERE name_key='gigapatton'").fetchone(), (254, 72))
        self.assertEqual(self.conn.execute("SELECT kills,deaths FROM leaderboard_seeds WHERE name_key='gigapatton'").fetchone(), (250, 70))

    def test_canonical_names_match_colors_whitespace_case_and_exclusions(self):
        self.assertEqual(seed.canonical_name("  ^3bIG\tDick\nBilly^9  "), ("big dick billy", "bIG Dick Billy"))
        self.assertEqual(seed.canonical_name("Giga\x00Patton"), ("gigapatton", "GigaPatton"))
        self.assertEqual(seed.canonical_name("Giga\x1cPatton"), ("gigapatton", "GigaPatton"))
        self.assertEqual(seed.canonical_name("^٣Adolf Superfan"), ("^٣adolf superfan", "^٣Adolf Superfan"))
        for name in ("", " ^3 ", "^7Unknown\tSoldier"):
            with self.assertRaises(ValueError):
                seed.canonical_name(name)


if __name__ == "__main__":
    unittest.main()
