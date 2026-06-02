import os
import sys
import logging
import sqlite3
from urllib.parse import quote_plus
import psycopg2

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("migrate_phase6")

# Load env files
env_paths = [".env", "backend/.env", "D:/projects/Lerno.ai/backend/.env", "D:/projects/Lerno.ai/.env"]
for env_path in env_paths:
    if os.path.exists(env_path):
        logger.info(f"Loading env from {env_path}")
        with open(env_path, "r") as f:
            for line in f:
                if "=" in line and not line.strip().startswith("#"):
                    key, val = line.strip().split("=", 1)
                    os.environ[key] = val

db_url = os.getenv("DATABASE_URL")
DB_FILE = os.getenv("SQLITE_DB_FILE", "lerno_learning.db")

def get_cleaned_db_url(url: str) -> str:
    if not url:
        return url
    if "postgresql://" in url:
        rest = url[len("postgresql://"):]
        parts = rest.split('@')
        if len(parts) >= 3:
            user_pass = parts[0] + "@" + parts[1]
            host_part = parts[2]
        elif len(parts) == 2:
            user_pass = parts[0]
            host_part = parts[1]
        else:
            return url
        user, password = user_pass.split(':', 1)
        host = "db.adcmallkqrucmhjzmvdj.supabase.co"
        port = "5432"
        dbname = "postgres"
        encoded_password = quote_plus(password)
        return f"postgresql://{user}:{encoded_password}@{host}:{port}/{dbname}"
    return url

def run_migrations():
    # Try Postgres first
    postgres_success = False
    if db_url:
        cleaned_url = get_cleaned_db_url(db_url)
        logger.info("Connecting to PostgreSQL to run Phase 6 migrations...")
        try:
            conn = psycopg2.connect(cleaned_url)
            cursor = conn.cursor()
            
            logger.info("Creating skills_unlocked table in Postgres...")
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS skills_unlocked (
                user_id TEXT NOT NULL,
                skill_id TEXT NOT NULL,
                unlocked_at DOUBLE PRECISION NOT NULL,
                PRIMARY KEY (user_id, skill_id),
                FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
            );
            """)

            logger.info("Creating xp_logs table in Postgres...")
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS xp_logs (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                xp_delta INTEGER NOT NULL,
                source_type TEXT NOT NULL,
                created_at DOUBLE PRECISION NOT NULL,
                FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
            );
            """)

            logger.info("Creating achievements table in Postgres...")
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS achievements (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                achievement_name TEXT NOT NULL,
                unlocked_at DOUBLE PRECISION NOT NULL,
                FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
            );
            """)

            conn.commit()
            cursor.close()
            conn.close()
            logger.info("Phase 6 PostgreSQL migrations completed successfully.")
            postgres_success = True
        except Exception as e:
            logger.warning(f"PostgreSQL migration failed: {e}. Falling back to SQLite migration.")

    # Run SQLite migration (always do this as backup/local testing database setup)
    logger.info(f"Running Phase 6 SQLite migrations on {DB_FILE}...")
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("PRAGMA foreign_keys = ON;")
        
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS skills_unlocked (
            user_id TEXT NOT NULL,
            skill_id TEXT NOT NULL,
            unlocked_at REAL NOT NULL,
            PRIMARY KEY (user_id, skill_id),
            FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
        );
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS xp_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            xp_delta INTEGER NOT NULL,
            source_type TEXT NOT NULL,
            created_at REAL NOT NULL,
            FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
        );
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS achievements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            achievement_name TEXT NOT NULL,
            unlocked_at REAL NOT NULL,
            FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
        );
        """)

        conn.commit()
        cursor.close()
        conn.close()
        logger.info("Phase 6 SQLite migrations completed successfully.")
    except Exception as e:
        logger.error(f"SQLite migration failed: {e}")
        if not postgres_success:
            sys.exit(1)

if __name__ == "__main__":
    run_migrations()
