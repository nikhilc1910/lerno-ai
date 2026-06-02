import sqlite3
import os
import time
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("init_db")

DB_FILE = os.getenv("SQLITE_DB_FILE", "lerno_learning.db")

def run_migrations():
    logger.info(f"Initializing database at {DB_FILE}...")
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # Enable foreign keys
    cursor.execute("PRAGMA foreign_keys = ON;")

    # 1. COGNITIVE EVOLUTION PROFILE (Learning DNA)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS learning_dna_profiles (
        user_id TEXT PRIMARY KEY,
        curiosity_type TEXT NOT NULL, -- Logical-Explorer, Creative-Writer, Visual-Artist, Story-Seeker
        learning_style TEXT NOT NULL, -- Visual, Kinesthetic, Auditory, Read-Write
        attention_span_average_sec INTEGER NOT NULL DEFAULT 45,
        pacing_preference TEXT NOT NULL DEFAULT 'medium',
        motivation_trigger TEXT NOT NULL, -- Achievement-oriented, Explorative, Collaborative
        persistence_score REAL NOT NULL DEFAULT 1.00, -- Scale of 0.00 to 5.00
        learning_maturity REAL NOT NULL DEFAULT 1.00,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    );
    """)

    # 2. TEMPORAL BEHAVIORAL TELEMETRY (For Boredom & Engagement Engine)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL, -- hover, click, retry, idle, keystroke
        element_id TEXT,
        interaction_speed_ms INTEGER,
        hover_duration_ms INTEGER,
        idle_before_action_ms INTEGER,
        response_latency_ms INTEGER,
        replay_count INTEGER DEFAULT 0,
        sentiment_score REAL, -- -1.00 (frustrated) to 1.00 (happy)
        recorded_at REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
    );
    """)

    # 3. ADAPTIVE WORLD STATES (World Continuity System)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS adaptive_worlds (
        user_id TEXT PRIMARY KEY,
        world_seed TEXT NOT NULL,
        current_dimension TEXT NOT NULL DEFAULT 'Genesis Prime',
        unlocked_regions TEXT NOT NULL DEFAULT '[]', -- JSON string of unlocked areas
        world_lore_summary TEXT,
        companion_relationship_score INTEGER DEFAULT 1, -- scale 1-100
        last_updated_at REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
    );
    """)

    # 4. EMOTIONAL MEMORY TIMELINE
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS emotional_memory_timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        milestone_type TEXT NOT NULL, -- biggest_win, failed_concept, recovered_topic, emotional_peak
        concept_id TEXT NOT NULL,
        description TEXT NOT NULL,
        associated_sentiment REAL NOT NULL,
        mastery_delta REAL,
        created_at REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
    );
    """)

    # 5. RECOMMENDATION SCORES & FEEDBACK LOGS
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS recommendation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        recommended_node_id TEXT NOT NULL,
        filtering_type TEXT NOT NULL, -- content-based, collaborative, rl-bandit, context-aware
        emotional_weighting REAL NOT NULL,
        engagement_outcome REAL, -- Outcome score: 0.0 (ignored) to 1.0 (completed)
        feedback_reward REAL,
        created_at REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
    );
    """)

    conn.commit()
    conn.close()
    logger.info("Database schemas initialized successfully.")

if __name__ == "__main__":
    run_migrations()
