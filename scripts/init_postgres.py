import os
import re
import sys
import time
import logging
from urllib.parse import quote_plus
import psycopg2

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("init_postgres")

# Read env variables from .env or backend/.env
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
if not db_url:
    logger.error("DATABASE_URL is not set in environment variables.")
    sys.exit(1)

def get_cleaned_db_url(url: str) -> str:
    """
    Cleans database URL by URL-encoding the password (which may contain '@')
    and resolving any copy-paste duplications.
    """
    if not url:
        return url
    
    if "postgresql://" in url:
        rest = url[len("postgresql://"):]
        # Split user/password part from host part by the last '@' before host
        # The password here is Nikhilchx@10
        # The host is db.adcmallkqrucmhjzmvdj.supabase.co
        parts = rest.split('@')
        if len(parts) >= 3:
            # We have postgres:Nikhilchx as parts[0], 10 as parts[1], and host as parts[2]
            user_pass = parts[0] + "@" + parts[1]
            host_part = parts[2]
        elif len(parts) == 2:
            user_pass = parts[0]
            host_part = parts[1]
        else:
            return url
            
        user, password = user_pass.split(':', 1)
        
        # Clean host_part: it may contain duplications like 'postgresdj.supabase.co:5432/postgres' at the end.
        # Clean host to 'db.adcmallkqrucmhjzmvdj.supabase.co'
        # The correct supabase project ref is 20 chars: 'adcmallkqrucmhjzmvdj'
        host = "db.adcmallkqrucmhjzmvdj.supabase.co"
        port = "5432"
        dbname = "postgres"
        
        encoded_password = quote_plus(password)
        clean = f"postgresql://{user}:{encoded_password}@{host}:{port}/{dbname}"
        return clean
    return url

cleaned_url = get_cleaned_db_url(db_url)

def run_migrations():
    logger.info("Connecting to PostgreSQL database...")
    try:
        conn = psycopg2.connect(cleaned_url)
        cursor = conn.cursor()
    except Exception as e:
        logger.error(f"Failed to connect to PostgreSQL: {e}")
        sys.exit(1)
        
    try:
        # 1. Enable pgvector
        logger.info("Enabling pgvector extension...")
        cursor.execute("CREATE EXTENSION IF NOT EXISTS vector;")
        conn.commit()
        
        # 2. COGNITIVE EVOLUTION PROFILE (Learning DNA)
        logger.info("Creating learning_dna_profiles table...")
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
            created_at DOUBLE PRECISION NOT NULL,
            updated_at DOUBLE PRECISION NOT NULL
        );
        """)
        
        # 3. TEMPORAL BEHAVIORAL TELEMETRY
        logger.info("Creating telemetry_events table...")
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_events (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL, -- hover, click, retry, idle, keystroke
            element_id TEXT,
            interaction_speed_ms INTEGER,
            hover_duration_ms INTEGER,
            idle_before_action_ms INTEGER,
            response_latency_ms INTEGER,
            replay_count INTEGER DEFAULT 0,
            sentiment_score REAL, -- -1.00 to 1.00
            recorded_at DOUBLE PRECISION NOT NULL,
            FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
        );
        """)
        
        # 4. ADAPTIVE WORLD STATES
        logger.info("Creating adaptive_worlds table...")
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS adaptive_worlds (
            user_id TEXT PRIMARY KEY,
            world_seed TEXT NOT NULL,
            current_dimension TEXT NOT NULL DEFAULT 'Genesis Prime',
            unlocked_regions TEXT NOT NULL DEFAULT '[]', -- JSON string of unlocked areas
            world_lore_summary TEXT,
            companion_relationship_score INTEGER DEFAULT 1, -- scale 1-100
            last_updated_at DOUBLE PRECISION NOT NULL,
            FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
        );
        """)
        
        # 5. EMOTIONAL MEMORY TIMELINE
        logger.info("Creating emotional_memory_timeline table...")
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS emotional_memory_timeline (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            milestone_type TEXT NOT NULL, -- biggest_win, failed_concept, recovered_topic, emotional_peak
            concept_id TEXT NOT NULL,
            description TEXT NOT NULL,
            associated_sentiment REAL NOT NULL,
            mastery_delta REAL,
            created_at DOUBLE PRECISION NOT NULL,
            FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
        );
        """)
        
        # 6. RECOMMENDATION SCORES & FEEDBACK LOGS
        logger.info("Creating recommendation_logs table...")
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS recommendation_logs (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            recommended_node_id TEXT NOT NULL,
            filtering_type TEXT NOT NULL, -- content-based, collaborative, rl-bandit, context-aware
            emotional_weighting REAL NOT NULL,
            engagement_outcome REAL, -- Outcome score: 0.0 to 1.0
            feedback_reward REAL,
            created_at DOUBLE PRECISION NOT NULL,
            FOREIGN KEY (user_id) REFERENCES learning_dna_profiles(user_id) ON DELETE CASCADE
        );
        """)
        
        conn.commit()
        logger.info("All PostgreSQL tables created successfully.")
    except Exception as e:
        conn.rollback()
        logger.error(f"Error running SQL migrations: {e}")
        sys.exit(1)
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    run_migrations()
