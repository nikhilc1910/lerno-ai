import json
import re
import os
import ast
import hashlib
from pathlib import Path
import logging
import threading
import time
import sqlite3
from dotenv import load_dotenv
from pydantic import BaseModel, Field, field_validator
from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.prompts import PromptTemplate
from langchain_community.utilities import WikipediaAPIWrapper
import subprocess
import firebase_admin
from firebase_admin import credentials, storage, auth
import uuid
from services.narration_service import generate_narration

# Define PII Scrubbing patterns
EMAIL_REGEX = re.compile(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+')
PHONE_REGEX = re.compile(r'\+?\b[1-9]\d{1,14}\b')
LAT_LONG_REGEX = re.compile(r'\b[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)\b')

def scrub_pii(text: str) -> str:
    if not isinstance(text, str):
        text = str(text)
    text = EMAIL_REGEX.sub('[REDACTED_EMAIL]', text)
    text = PHONE_REGEX.sub('[REDACTED_PHONE]', text)
    text = LAT_LONG_REGEX.sub('[REDACTED_COORDINATES]', text)
    return text

class PIIScrubbingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        formatted = super().format(record)
        return scrub_pii(formatted)

# Configure logging
handler = logging.StreamHandler()
handler.setFormatter(PIIScrubbingFormatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
logging.basicConfig(level=logging.INFO, handlers=[handler])
logger = logging.getLogger(__name__)

DB_FILE = os.getenv("SQLITE_DB_FILE", str(Path(__file__).parent / "lerno_learning.db"))

import redis
import chromadb
from chromadb.config import Settings
from psycopg2.pool import ThreadedConnectionPool
from urllib.parse import quote_plus
from contextlib import contextmanager

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

db_pool = None
use_sqlite = False

db_url = os.getenv("DATABASE_URL")
if db_url:
    try:
        cleaned_url = get_cleaned_db_url(db_url)
        db_pool = ThreadedConnectionPool(1, 20, dsn=cleaned_url)
        logger.info("PostgreSQL ThreadedConnectionPool initialized successfully.")
    except Exception as e:
        logger.error(f"Failed to initialize PostgreSQL connection pool: {e}. Falling back to SQLite.")
        use_sqlite = True
else:
    logger.info("DATABASE_URL not set. Falling back to SQLite.")
    use_sqlite = True

@contextmanager
def get_db_cursor():
    global db_pool, use_sqlite
    if use_sqlite or db_pool is None:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        try:
            yield cursor, True
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    else:
        conn = db_pool.getconn()
        cursor = conn.cursor()
        try:
            yield cursor, False
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            db_pool.putconn(conn)

def execute_db(cursor, is_sqlite, query, params=None):
    if params is None:
        params = ()
    if not is_sqlite:
        query = query.replace('?', '%s')
    cursor.execute(query, params)

# Redis setup
redis_client = None
redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
if redis_url:
    try:
        redis_client = redis.Redis.from_url(redis_url, socket_timeout=3.0)
        redis_client.ping()
        logger.info("Redis client connected successfully.")
    except Exception as e:
        logger.warning(f"Failed to connect to Redis: {e}. Running in local/offline cache mode.")
        redis_client = None

# ChromaDB setup
chroma_client = None
chroma_url = os.getenv("CHROMADB_URL", "http://localhost:8001")
if chroma_url:
    try:
        m = re.match(r"https?://([^:]+):(\d+)", chroma_url)
        if m:
            host = m.group(1)
            port = int(m.group(2))
        else:
            host = "localhost"
            port = 8001
        chroma_client = chromadb.HttpClient(host=host, port=port, settings=Settings(anonymized_telemetry=False))
        chroma_client.heartbeat()
        logger.info(f"ChromaDB HTTP client connected to {host}:{port} successfully.")
    except Exception as e:
        logger.warning(f"Failed to connect to ChromaDB: {e}. Running in local/offline vector mode.")
        chroma_client = None


BANNED_IMPORTS = {
    'os', 'sys', 'subprocess', 'shutil', 'socket',
    'requests', 'urllib', 'http', 'ftplib', 'smtplib',
    'pickle', 'marshal', 'importlib', 'builtins', 'pathlib'
}
BANNED_CALLS = {
    'eval', 'exec', 'compile', '__import__',
    'open', 'input', 'breakpoint', 'getattr', 'setattr', 'delattr'
}
BANNED_ATTRS = {
    'system', 'popen', 'listdir', 'remove', 'rmdir',
    'unlink', 'chmod', 'environ', 'getenv', 'putenv'
}

def validate_manim_code(code: str) -> tuple[bool, str]:
    """
    Parses generated Python code with ast.parse() and rejects any code
    that imports banned modules or calls dangerous built-ins.
    Returns (is_safe: bool, reason: str).
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return False, f"Syntax error at line {e.lineno}: {e.msg}"

    for node in ast.walk(tree):
        # Block banned imports: import os / from sys import ...
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in getattr(node, 'names', []):
                base = alias.name.split('.')[0]
                if base in BANNED_IMPORTS:
                    return False, f"Blocked import: {alias.name}"

        # Block banned built-in calls: eval(), exec(), open()
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                if node.func.id in BANNED_CALLS:
                    return False, f"Blocked call: {node.func.id}()"

        # Block dangerous attribute access: os.system, os.environ, etc.
        if isinstance(node, ast.Attribute):
            if node.attr in BANNED_ATTRS:
                return False, f"Blocked attribute access: .{node.attr}"

    return True, ""


MANIM_AUDIT_DIR = Path("/tmp/lerno_manim_audit")
MANIM_AUDIT_DIR.mkdir(parents=True, exist_ok=True)

logger.info(f"Manim audit logs → {MANIM_AUDIT_DIR}")

def audit_log_script(code: str, scene_idx: int, passed: bool, reason: str = "") -> None:
    """
    Writes every generated Manim script to /tmp/lerno_manim_audit/ for debugging.
    Files are prefixed ok_ or blocked_ so failures are easy to find.
    """
    try:
        h = hashlib.md5(code.encode()).hexdigest()[:8]
        prefix = "ok" if passed else "blocked"
        fpath = MANIM_AUDIT_DIR / f"{prefix}_scene{scene_idx}_{h}.py"
        header = f"# passed={passed}  reason={reason or 'none'}\n\n"
        fpath.write_text(header + code)
    except Exception as e:
        logger.warning(f"Could not write audit log: {e}")


async def ask_gemini_to_fix_manim(
    topic: str,
    scene_idx: int,
    failed_code: str,
    error_msg: str,
    attempt: int,
) -> str:
    fix_prompt = f"""A Manim CE v0.19.0 script failed on attempt {attempt}.

EXACT ERROR (last 800 chars):
{error_msg[-800:]}

FAILED CODE:
{failed_code}

Rewrite so it compiles. Rules:
- Do NOT use: scale_tips, match_style on Arrow, get_graph (use .plot())
- Do NOT use np.PI — use bare PI from manim
- Do NOT import: os, sys, subprocess, requests, pathlib
- Every class MUST extend Scene and implement construct(self)
- Return ONLY corrected Python code — no markdown fences

Context: scene {scene_idx} of a lesson about "{topic}"."""

    if not model:
        raise ValueError("Gemini API model is not configured or unavailable.")

    # Using model.ainvoke to execute Gemini API call asynchronously
    resp = await model.ainvoke(fix_prompt)
    raw = resp.content.strip()
    raw = re.sub(r"^```(?:python)?\n", "", raw)
    raw = re.sub(r"\n```$", "", raw)
    return raw.strip()


MAX_MANIM_ATTEMPTS = 3

async def compile_scene_with_retry(
    topic: str,
    scene_idx: int,
    initial_code: str,
    job_id: str,
    write_script_fn,
    run_manim_fn,
    placeholder_url: str,
) -> tuple[str, bool]:
    code = initial_code
    for attempt in range(1, MAX_MANIM_ATTEMPTS + 1):
        job_store.update(job_id, {
            "log": f"Compiling scene {scene_idx} — attempt {attempt}/{MAX_MANIM_ATTEMPTS}…",
            "message": f"Compiling scene {scene_idx} — attempt {attempt}/{MAX_MANIM_ATTEMPTS}…"
        })

        # Gate 1: AST safety
        is_safe, reason = validate_manim_code(code)
        audit_log_script(code, scene_idx, is_safe, reason)
        if not is_safe:
            logger.warning(f"job={job_id} scene={scene_idx} attempt={attempt} AST blocked: {reason}")
            if attempt < MAX_MANIM_ATTEMPTS:
                code = await ask_gemini_to_fix_manim(
                    topic, scene_idx, code, f"Safety violation: {reason}", attempt)
                continue
            job_store.update(job_id, {"scene_warnings": f"scene {scene_idx}: placeholder after {MAX_MANIM_ATTEMPTS} AST violations"})
            return placeholder_url, False

        # Gate 2: Manim compile
        script_path = write_script_fn(code, scene_idx)
        try:
            result = run_manim_fn(script_path)
        except subprocess.TimeoutExpired:
            logger.error(f"job={job_id} scene={scene_idx} attempt={attempt} timeout")
            result = None

        if result is not None and result.returncode == 0:
            logger.info(f"job={job_id} scene={scene_idx} OK on attempt {attempt}")
            return script_path, True

        error_text = result.stderr if result else "Timed out after 90 seconds"
        logger.warning(f"job={job_id} scene={scene_idx} attempt={attempt} failed: {error_text[-200:]}")
        if attempt < MAX_MANIM_ATTEMPTS:
            code = await ask_gemini_to_fix_manim(topic, scene_idx, code, error_text, attempt)

    logger.error(f"job={job_id} scene={scene_idx} all {MAX_MANIM_ATTEMPTS} attempts failed")
    job_store.update(job_id, {"scene_warnings": f"scene {scene_idx}: placeholder after {MAX_MANIM_ATTEMPTS} failed attempts"})
    return placeholder_url, False

JOBS_FILE = Path(os.getenv("JOBS_FILE", "/tmp/lerno_jobs.json"))
JOB_TTL_SECONDS = 86400  # auto-expire jobs after 24 hours


class DiskJobStore:
    """
    Thread-safe job store that persists job state to a JSON file on disk.
    Survives uvicorn restarts. No external dependencies — pure Python stdlib.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._data: dict = {}
        self._load()

    # ── private ──────────────────────────────────────────────

    def _load(self) -> None:
        """Load jobs from disk on startup, dropping any older than TTL."""
        if not JOBS_FILE.exists():
            logger.info("Job store: no existing file, starting fresh")
            return
        try:
            raw: dict = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
            cutoff = time.time() - JOB_TTL_SECONDS
            self._data = {
                k: v for k, v in raw.items()
                if isinstance(v, dict) and v.get("created_at", 0) > cutoff
            }
            dropped = len(raw) - len(self._data)
            logger.info(
                f"Job store: loaded {len(self._data)} jobs "
                f"({dropped} expired entries dropped)"
            )
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning(f"Job store: could not load {JOBS_FILE}: {exc} — starting fresh")
            self._data = {}

    def _persist(self) -> None:
        """Write current state to disk. Called inside the lock."""
        try:
            JOBS_FILE.write_text(
                json.dumps(self._data, indent=2, default=str),
                encoding="utf-8"
            )
        except OSError as exc:
            logger.warning(f"Job store: could not persist to {JOBS_FILE}: {exc}")

    # ── public API ────────────────────────────────────────────

    def create(self, job_id: str, initial_data: dict) -> None:
        """Create a new job entry. Overwrites if job_id already exists."""
        with self._lock:
            self._data[job_id] = {
                **initial_data,
                "created_at": time.time(),
            }
            self._persist()

    def get(self, job_id: str) -> dict | None:
        """Return job dict or None if not found."""
        return self._data.get(job_id)

    def update(self, job_id: str, patch: dict) -> None:
        """Merge patch into an existing job. Silently ignores unknown job_id."""
        with self._lock:
            if job_id in self._data:
                self._data[job_id].update(patch)
                self._persist()
            else:
                logger.warning(f"Job store: update called on unknown job_id={job_id}")

    def delete(self, job_id: str) -> None:
        """Remove a job entry."""
        with self._lock:
            if self._data.pop(job_id, None) is not None:
                self._persist()

    def exists(self, job_id: str) -> bool:
        """Return True if job_id is in the store."""
        return job_id in self._data

    def cleanup_expired(self) -> int:
        """Remove jobs older than TTL. Returns count of removed jobs."""
        with self._lock:
            cutoff = time.time() - JOB_TTL_SECONDS
            before = len(self._data)
            self._data = {
                k: v for k, v in self._data.items()
                if v.get("created_at", 0) > cutoff
            }
            removed = before - len(self._data)
            if removed:
                self._persist()
                logger.info(f"Job store: cleaned up {removed} expired jobs")
            return removed


# ── Instantiate the store (replaces the old in-memory dict) ──
job_store = DiskJobStore()
logger.info(f"Job store: persistence file → {JOBS_FILE.resolve()}")

firebase_admin_initialized = False
try:
    load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")
    load_dotenv()
    firebase_creds_path = os.getenv("FIREBASE_CREDENTIALS_JSON", "lerno-998e4-firebase-adminsdk-fbsvc-736e959000.json")
    cred = credentials.Certificate(firebase_creds_path)
    storage_bucket = os.getenv("FIREBASE_STORAGE_BUCKET", "lerno-998e4.firebasestorage.app")
    firebase_admin.initialize_app(cred, {"storageBucket": storage_bucket})
    firebase_admin_initialized = True
except Exception as e:
    logger.error(f"Failed to initialize Firebase Admin SDK, running in mock/offline mode: {e}")

# For Storing Videos and manim Generation
bucket = storage.bucket() if firebase_admin_initialized else None

security = HTTPBearer()

async def verify_firebase_token(request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)):
    # Check for microservice gateway headers first
    user_id = request.headers.get("x-user-id")
    if user_id:
        return {
            "uid": user_id,
            "email": request.headers.get("x-user-email", "student@lerno.ai"),
            "role": request.headers.get("x-user-role", "child_user")
        }

    token = credentials.credentials
    if not firebase_admin_initialized:
        return {"uid": token if token and len(token) > 5 else "defaultUser"}
    try:
        decoded_token = auth.verify_id_token(token)
        return decoded_token
    except Exception as e:
        if token == "mock-token" or token == "defaultUser":
            return {"uid": "defaultUser"}
        raise HTTPException(
            status_code=401,
            detail=f"Invalid or expired Firebase ID token: {str(e)}"
        )

gemini_api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "AIzaSyCGTV-hfbcGYqbXZdFSi_LkctKNsZUP7w4"

# Ensure keys are set in environment for child libraries
os.environ["GOOGLE_API_KEY"] = gemini_api_key
os.environ["GEMINI_API_KEY"] = gemini_api_key

PLACEHOLDER_VIDEO_URL = "https://storage.googleapis.com/lerno-998e4.appspot.com/placeholder.mp4"

model = None
try:
    model = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        google_api_key=gemini_api_key,
        temperature=0.7,
        max_output_tokens=4000
    )
except Exception as e:
    logger.error(f"Failed to initialize Gemini ChatGoogleGenerativeAI model: {e}")

gemini_client = None
try:
    import google.generativeai as genai
    genai.configure(api_key=gemini_api_key)
    gemini_client = genai.GenerativeModel("gemini-2.5-flash")
except Exception as e:
    logger.error(f"Failed to initialize raw google.generativeai client: {e}")

wikipedia = WikipediaAPIWrapper(top_k_results=2)

STORYBOARD_PROMPT_TEMPLATE = PromptTemplate(
    input_variables=["audience", "topic", "wikipedia_info"],
    template="""For an audience of a {audience}, generate a series of 3 frames to explain {topic}. Each frame should be a single animation point, such as visualizing squaring a number visually or adding a vector tip to tail. It should not take longer than 15 seconds.
    Also use this wikipedia information to help create the frames {wikipedia_info}, but it is not necessary only for reference.

For example, explaining vector addition would be:
1. Frame showing 2 vectors from the origin explaining that these can be any arbitrary vector.
2. Showing vector addition numerically, adding each component numerically.
3. Explain a simple practical example of vector addition, how 2 forces can combine together into a larger force.

Do not include a frame for a quiz.

Each frame should come with a short description of what it will talk about. This is meant to be the storyboard for an animated video explaining this concept.

Format the frames in the following JSON format:

{{ "frames": 
[
{{
"title": "xxxx",
"description": "xxxx"
}},
{{
"title": "xxxx",
"description": "xxxx"
}},
{{
"title": "xxxx",
"description": "xxxx"
}}
]
}}

Ensure that the JSON is valid.

The title should be short, limit of 5 words.
The description should be a few sentences, enough for someone to understand what to do and how to animate and explain this frame.

Output only the plaintext JSON format of the frames. DO NOT OUTPUT MARKDOWN. DO NOT INCLUDE A PREAMBLE OR POSTAMBLE."""
)

############################################################---- OLD PROMPT --------##########################################################################
# SCENE_AGENT_PROMPT_TEMPLATE = PromptTemplate(
#     input_variables=["frame"],
#     template="""Given the following, generate a script and animation description in the style of 3Blue1Brown.

# {frame}

# The script will be read orally to the student. This should not take longer than 10-15 seconds.
# The animation description should be descriptive of what should be shown on the screen along with relevant positional information. (e.g., The number line should be centered vertically on the screen with a range of -10 to 10 with ticks for every 0.2, there is a blue arrow above the number line pointing from 0 to +5. The arrow will then shrink until it points to +2.)

# IMPORTANT: Do NOT include ANY REFERENCE to 'scale_tips' parameter in the animation description, as this parameter is not supported in Manim CE 0.19.0.

# In addition, generate a 4-choice multiple-choice question and a free-response question that can be asked at the end of the video.

# Instead of always putting the correct answer first in the multiple-choice array, randomly place it at any position, and then specify which index (0, 1, 2, or 3) contains the correct answer in the "correct-index" field.

# The answer for the free response should be a string.

# Return the data in the following format:

# {{
# "narration": "string",
# "animation-description": "string",
# "free-response-question": "string",
# "free-response-answer": "string",
# "multiple-choice-question": "string",
# "multiple-choice-choices": ["choice1 - string", "choice2 - string", "choice3 - string", "choice4 - string"],
# "correct-index": integer (0-3)
# }}

# THE RESPONSE SHOULD ONLY BE A VALID PLAINTEXT JSON FORMAT. DO NOT OUTPUT MARKDOWN. DO NOT INCLUDE A PREAMBLE OR POSTAMBLE."""
# )
############################################################---- OLD PROMPT --------##########################################################################

SCENE_AGENT_PROMPT_TEMPLATE = PromptTemplate(
    input_variables=["frame"],
    template="""Given the following, generate a script and animation description in the style of 3Blue1Brown.

{frame}

The script will be read orally to the student. This should not take longer than 5-10 seconds meaning not more than 30 words long strictly.
The animation description should be descriptive of what should be shown on the screen along with relevant positional information. (e.g., The number line should be centered vertically on the screen with a range of -10 to 10 with ticks for every 0.2, there is a blue arrow above the number line pointing from 0 to +5. The arrow will then shrink until it points to +2.)

IMPORTANT: Do NOT include ANY REFERENCE to 'scale_tips' parameter in the animation description, as this parameter is not supported in Manim CE 0.19.0.

In addition, generate a 4-choice multiple-choice question and a free-response question that can be asked at the end of the video.

Instead of always putting the correct answer first in the multiple-choice array, randomly place it at any position, and then specify which index (0, 1, 2, or 3) contains the correct answer in the "correct-index" field.

The answer for the free response should be a string.

Return the data in the following format:

{{
"narration": "string",
"animation-description": "string",
"free-response-question": "string",
"free-response-answer": "string",
"multiple-choice-question": "string",
"multiple-choice-choices": ["choice1 - string", "choice2 - string", "choice3 - string", "choice4 - string"],
"correct-index": integer (0-3)
}}

THE RESPONSE SHOULD ONLY BE A VALID PLAINTEXT JSON FORMAT. DO NOT OUTPUT MARKDOWN. DO NOT INCLUDE A PREAMBLE OR POSTAMBLE."""
)


EXAMPLE_CODE = r'''
from manim import *

class IntroductionToVector(Scene):
    def construct(self):
        axes = Axes(
            x_range=[-5, 5, 1], y_range=[-3, 3, 1],
            axis_config={"color": BLUE}
        )
        
        vector = Arrow(ORIGIN, [2, 1, 0], buff=0, color=YELLOW)
        vector_label = MathTex(r"\vec{{v}} = (2,1)").next_to(vector, UP)
        
        x_component = DashedLine(start=ORIGIN, end=[2, 0, 0], color=RED)
        y_component = DashedLine(start=[2, 0, 0], end=[2, 1, 0], color=GREEN)
        
        x_label = MathTex("2").next_to(x_component, DOWN)
        y_label = MathTex("1").next_to(y_component, RIGHT)
        
        self.play(Create(axes))
        self.play(GrowArrow(vector), Write(vector_label))
        self.play(Create(x_component), Write(x_label))
        self.play(Create(y_component), Write(y_label))
        
        self.wait(2)
        
        vector2 = Arrow([2, 1, 0], [4, 3, 0], buff=0, color=ORANGE)
        vector2_label = MathTex(r"\vec{{w}} = (2,2)").next_to(vector2, UP)
        
        result_vector = Arrow(ORIGIN, [4, 3, 0], buff=0, color=PURPLE)
        result_label = MathTex(r"\vec{{v}} + \vec{{w}} = (4,3)").next_to(result_vector, UP)
        
        self.play(GrowArrow(vector2), Write(vector2_label))
        self.wait(1)
        self.play(GrowArrow(result_vector), Write(result_label))
        
        self.wait(2)
'''

BANNED_WORDS_REGEX = re.compile(
    r'\b(violence|gore|murder|kill|blood|drug|cocaine|marijuana|sex|nude|porn|explicit|politics|election|democrat|republican|religion|christian|muslim|jewish|atheist)\b',
    re.IGNORECASE
)

def verify_child_safety(text: str) -> str:
    """
    Validates output text against guidelines. Raises ValueError if violations are found.
    """
    if BANNED_WORDS_REGEX.search(text):
        raise ValueError("AI output blocked: Content did not pass age-appropriate safety filter guidelines.")
    return text

class GeminiUnavailableError(Exception):
    """Raised when the Gemini API is not configured or fails to respond."""
    pass

def generate_response(prompt):
    """Extract JSON from Gemini's response with safety check and error handling"""
    if not model:
        raise GeminiUnavailableError("Gemini API is unavailable or not configured. Please check GEMINI_API_KEY.")
    try:
        message = model.invoke(prompt)
    except Exception as e:
        logger.error(f"Gemini API error during invocation: {e}")
        raise GeminiUnavailableError(f"Gemini API is currently unavailable: {str(e)}")
        
    text = verify_child_safety(message.content)
    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    if json_match:
        return json_match.group(0)
    else:
        return ""

def generate_response_raw(prompt):
    """Get raw text response from Gemini with safety check and error handling"""
    if not model:
        raise GeminiUnavailableError("Gemini API is unavailable or not configured. Please check GEMINI_API_KEY.")
    try:
        message = model.invoke(prompt)
    except Exception as e:
        logger.error(f"Gemini API error during raw invocation: {e}")
        raise GeminiUnavailableError(f"Gemini API is currently unavailable: {str(e)}")
        
    return verify_child_safety(message.content.strip())

def classify_input(user_input):
    """Classifies user input into topic and audience level using Gemini."""
    prompt = f"""Classify the following input into a topic to explain and an audience level. If no audience level is explicitly mentioned, default to "college student".

    Input: "{user_input}"

    Return ONLY a JSON object with "topic" and "audience" as keys. For example:
    {{
        "topic": "quantum physics",
        "audience": "high school students"
    }}
    """
    if not model:
        logger.error("Gemini API is unavailable for classification.")
        return {"topic": user_input, "audience": "college student"}
        
    try:
        response = model.invoke(prompt)
        text = response.content
        json_match = re.search(r"\{.*\}", text, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group(0))
            return result
        else:
            return {"topic": user_input, "audience": "college student"}
    except Exception as e:
        logger.error(f"Error classifying input with Gemini: {e}")
        return {"topic": user_input, "audience": "college student"}

def create_storyboard(audience, topic):
    """Generate a storyboard of frames to explain the topic"""
    wikipedia_info = wikipedia.run(topic)
    prompt = STORYBOARD_PROMPT_TEMPLATE.format(audience=audience, topic=topic, wikipedia_info=wikipedia_info)
    storyboard_json = generate_response(prompt)
    try:
        return json.loads(storyboard_json)
    except json.JSONDecodeError as e:
        print(f"Error decoding JSON: {e}")
        print(f"Received JSON: {storyboard_json}")
        return None

def generate_scene(frame):
    """Generate a scene description from a frame"""
    prompt = SCENE_AGENT_PROMPT_TEMPLATE.format(frame=frame)
    scene_json = generate_response(prompt)
    try:
        return json.loads(scene_json)
    except json.JSONDecodeError as e:
        print(f"Error decoding JSON: {e}")
        print(f"Received JSON: {scene_json}")
        return None

def generate_animation_code(narration, animation_description, title, scene_number=None):
    """Generate Manim animation code for a scene"""
    if scene_number:
        scene_class_name = f"Scene{scene_number}"
    else:
        scene_class_name = ''.join(c for c in title if c.isalnum())
        if not scene_class_name:
            scene_class_name = "AnimationScene"
    
    prompt = """
0. Use EXTREMELY SIMPLE Manim code with NO LOOPS or complex logic,Generate only those stuff which is possible in manim , Don't try to use complex shape or function like ImageMobject.
1. Given the scene description and title, write COMPLETE, READY-TO-RUN Manim code for this scene in 3Blue1Brown style. This scene should be between 10 to 20 seconds.
2. USE MANIM COMMUNITY EDITION (ManimCE) VERSION 0.19.0 SYNTAX ONLY.
3. Include: from manim import *
4. Use "{0}" as class name (not "Scene").
5. DO NOT INCLUDE python TAGS OR ANY MARKDOWN.
6. DO NOT INCLUDE ANY INTRODUCTION LIKE "Here's the Manim code for the scene based on your requirements:" OR OTHER EXPLANATORY TEXT.
7. CRITICAL RESTRICTIONS:
   - ABSOLUTELY NO FOR LOOPS OR WHILE LOOPS
   - NO LIST COMPREHENSIONS
   - NO CUSTOM FUNCTIONS OR METHODS
   - USE ONLY SIMPLE SEQUENTIAL ANIMATIONS
   - LIMIT TO 5-7 SEQUENTIAL self.play() CALLS MAXIMUM
   - NO CONDITIONAL LOGIC (if/else statements)
8. AVOID:
   - ThoughtBubble (use Text, MathTex, SurroundingRectangle, or Circle)
   - Deprecated methods/parameters (add_tip(), scale_tips)
   - Constructor conflicts
   - Brace.get_text() (use Tex/MathTex and position manually)
9. For arrows: Arrow(start=ORIGIN, end=[x,y,0], buff=0, color=YELLOW)
10. For axes: Axes(x_range=[-5, 5, 1], y_range=[-3, 3, 1])
11. Use Text() or MathTex() with font_size 24-30pt.
12. Use standard animations: Create(), Write(), FadeIn/Out(), Transform(), GrowArrow()
13. Use [x, y, 0] coordinate system for all 2D points.
14. Include self.play() with self.wait() commands.

15. TEXT POSITIONING (CRITICAL):
   - NEVER place text on top of other text
   - For titles, use .to_edge(UP, buff=1) with sufficient buffer
   - For subtitles, position below titles with .next_to(title, DOWN, buff=0.5)
   - Use .shift(UP/DOWN/LEFT/RIGHT) to ensure text doesn't overlap
   - If using multiple text elements, create a VGroup and use .arrange(DOWN, buff=0.5)
   - Always add sufficient spacing between text elements (minimum buff=0.3)
   - For multi-line text, create separate Text objects and arrange them vertically

16. Use colors: RED, GREEN, BLUE, YELLOW, PURPLE, ORANGE, WHITE.
17. Use 2-AXIS DIAGRAMS for math concepts.
18. Don't invent parameters.
19. Keep text concise (<10 words).
20. Follow title if description is vague.
21. Include animations and place topic at bottom.
22. NEVER USE 'scale_tips' PARAMETER.
23. NEVER use random() or random.choice() functions
24.DON'T DO THIS "```python" IN THE CODE BLOCK, JUST WRITE THE MANIM CODE.
25. For 384px height compatibility:
   - Center elements (±3 units from center)
   - Keep content in middle 70% of screen
   - Use font_size≥24
   - Maximum 3-4 elements at once
   - Scale complex equations to 0.8
   - Keep 0.5 units padding from edges
   - Use WHITE/YELLOW text on dark backgrounds
   - Scale complex diagrams to 0.7

Here is an example of valid Manim CE 0.19.0 code:

from manim import *

class VectorExample(Scene):
    def construct(self):
        # Create axes
        axes = Axes(
            x_range=[-5, 5, 1], 
            y_range=[-3, 3, 1],
            axis_config={{"color": BLUE}}
        )
        
        # Create a vector as an arrow
        vector = Arrow(start=ORIGIN, end=[2, 1, 0], buff=0, color=YELLOW)
        vector_label = MathTex(r"\\vec{{v}} = (2,1)").next_to(vector, UP)
        
        # Create components
        x_component = DashedLine(start=ORIGIN, end=[2, 0, 0], color=RED)
        y_component = DashedLine(start=[2, 0, 0], end=[2, 1, 0], color=GREEN)
        
        x_label = MathTex("2").next_to(x_component, DOWN)
        y_label = MathTex("1").next_to(y_component, RIGHT)
        
        # Animation sequence
        self.play(Create(axes))
        self.wait(0.5)
        self.play(GrowArrow(vector), Write(vector_label))
        self.wait(0.5)
        self.play(Create(x_component), Write(x_label))
        self.wait(0.5)
        self.play(Create(y_component), Write(y_label))
        self.wait(1)

Narration: 
{1}

Animation Description:
{2}

Title:
{3}

ONLY RETURN THE COMPLETE MANIM CODE FOR THE SCENE. DO NOT INCLUDE A PREAMBLE OR POSTAMBLE.
""".format(scene_class_name, narration, animation_description, title) 
    
    response = generate_response_raw(prompt)
    if not response:
        response = f"""from manim import *
class {scene_class_name}(Scene):
    def construct(self):
        text = Text("No animation generated", font_size=48)
        self.play(Write(text))
        self.wait(1)
        """

    response = response.replace("scale_tips=True", "")
    response = response.replace("scale_tips=False", "")
    response = response.replace("scale_tips = True", "")
    response = response.replace("scale_tips = False", "")
    response = response.replace(", scale_tips", "")
    response = response.replace(",scale_tips", "")

    run_instructions = """# To run this animation, use the following command:
# manim -pql <filename>.py {0}
# or for higher quality:
# manim -pqh <filename>.py {0}
""".format(scene_class_name)

    return run_instructions + response

def generate_educational_content(user_input):
    """Generate complete educational content from a user input"""
    classification = classify_input(user_input)
    audience = classification.get("audience", "college student")
    topic = classification.get("topic", user_input)
    
    storyboard = create_storyboard(audience, topic)
    result = {
        "metadata": {
            "topic": topic,
            "audience": audience
        },
        "success": False,
        "scenes": []
    }
    
    if storyboard and "frames" in storyboard:
        result["success"] = True
        
        for i, frame in enumerate(storyboard["frames"]):
            if i >= 5:
                break
            
            scene_number = i + 1
            scene_data = {
                "scene_number": scene_number,
                "title": frame["title"],
                "description": frame["description"]
            }
            
            scene = generate_scene(frame["description"])
            if scene:
                if "narration" in scene:
                    scene_data["narration"] = scene["narration"]
                if "animation-description" in scene:
                    scene_data["animation_description"] = scene["animation-description"]
                
                scene_data["assessment"] = {
                    "multiple_choice": {
                        "question": scene.get("multiple-choice-question", ""),
                        "choices": scene.get("multiple-choice-choices", []),
                        "correct_index": scene.get("correct-index", 0)
                    },
                    "free_response": {
                        "question": scene.get("free-response-question", ""),
                        "answer": scene.get("free-response-answer", "")
                    }
                }
                
                scene_data["manim_code"] = generate_animation_code(
                    scene.get("narration", ""), 
                    scene.get("animation-description", ""), 
                    frame["title"],
                    scene_number
                )
            
            result["scenes"].append(scene_data)
    
    return result

app = FastAPI()

from starlette.middleware.base import BaseHTTPMiddleware

class LimitUploadSizeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        max_size = 100 * 1024  # 100KB
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > max_size:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "Payload Too Large: Maximum request size is 100KB."}
                    )
            except ValueError:
                pass
        return await call_next(request)

app.add_middleware(LimitUploadSizeMiddleware)

# Mount static folder for narrations
os.makedirs(str(Path(__file__).parent / "narrations"), exist_ok=True)
app.mount("/narrations", StaticFiles(directory=str(Path(__file__).parent / "narrations")), name="narrations")

INJECTION_PHRASES = [
    "ignore previous",
    "ignore all",
    "ignore instructions",
    "system prompt",
    "jailbreak",
    "act as",
    "you are now",
    "disregard",
    "new instruction",
    "forget everything",
    "override",
    "do not follow",
]

class LessonRequest(BaseModel):
    topic: str = Field(
        ...,
        min_length=3,
        max_length=200,
        description="The learning topic to generate a visual lesson for"
    )

    @field_validator("topic")
    @classmethod
    def sanitise_topic(cls, v: str) -> str:
        cleaned = v.strip()
        lower = cleaned.lower()
        for phrase in INJECTION_PHRASES:
            if phrase in lower:
                raise ValueError("Invalid topic — please enter a real learning subject")
        return cleaned

class prompt(BaseModel):
    prompt:str

class TelemetryEvent(BaseModel):
    session_id: str
    event_type: str
    element_id: str | None = None
    interaction_speed_ms: int | None = None
    hover_duration_ms: int | None = None
    idle_before_action_ms: int | None = None
    response_latency_ms: int | None = None
    replay_count: int | None = 0
    sentiment_score: float | None = None

def ensure_learning_dna_profile(user_id: str) -> None:
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query_select = "SELECT 1 FROM learning_dna_profiles WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_select, (user_id,))
            if not cursor.fetchone():
                now = time.time()
                query_insert = """
                    INSERT INTO learning_dna_profiles (
                        user_id, curiosity_type, learning_style, attention_span_average_sec,
                        pacing_preference, motivation_trigger, persistence_score, learning_maturity,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """
                execute_db(cursor, is_sqlite, query_insert, (
                    user_id,
                    "Logical-Explorer",
                    "Visual",
                    45,
                    "medium",
                    "Explorative",
                    1.0,
                    1.0,
                    now,
                    now
                ))
                logger.info(f"Created default learning DNA profile for user: {user_id}")
    except Exception as e:
        logger.error(f"Error ensuring learning DNA profile: {e}")

def save_telemetry_event(user_id: str, event: TelemetryEvent) -> None:
    ensure_learning_dna_profile(user_id)
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query_insert = """
                INSERT INTO telemetry_events (
                    user_id, session_id, event_type, element_id, interaction_speed_ms,
                    hover_duration_ms, idle_before_action_ms, response_latency_ms,
                    replay_count, sentiment_score, recorded_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """
            execute_db(cursor, is_sqlite, query_insert, (
                user_id,
                event.session_id,
                event.event_type,
                event.element_id,
                event.interaction_speed_ms,
                event.hover_duration_ms,
                event.idle_before_action_ms,
                event.response_latency_ms,
                event.replay_count,
                event.sentiment_score,
                time.time()
            ))
            logger.info(f"Saved telemetry event {event.event_type} for user: {user_id}")
    except Exception as e:
        logger.error(f"Failed to save telemetry event: {e}")

def evolve_cognitive_profile(user_id: str) -> dict:
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query_select_telemetry = """
                SELECT event_type, interaction_speed_ms, hover_duration_ms, idle_before_action_ms, response_latency_ms
                FROM telemetry_events
                WHERE user_id = ?
                ORDER BY recorded_at DESC
                LIMIT 200
            """
            execute_db(cursor, is_sqlite, query_select_telemetry, (user_id,))
            events = cursor.fetchall()
            
            query_select_completed = """
                SELECT COUNT(*) 
                FROM recommendation_logs 
                WHERE user_id = ? AND engagement_outcome >= 0.8
            """
            execute_db(cursor, is_sqlite, query_select_completed, (user_id,))
            completed_nodes = cursor.fetchone()[0]

            query_select_recovered = """
                SELECT COUNT(*) 
                FROM emotional_memory_timeline 
                WHERE user_id = ? AND milestone_type = 'recovered_topic'
            """
            execute_db(cursor, is_sqlite, query_select_recovered, (user_id,))
            recovered_topics = cursor.fetchone()[0]

            if not events:
                return {"status": "skipped", "reason": "No telemetry data"}

            total_clicks = sum(1 for e in events if e[0] == 'click')
            total_idles = sum(1 for e in events if e[0] == 'idle')
            
            hover_durations = [e[2] for e in events if e[0] == 'hover' and e[2] is not None]
            avg_hover_sec = (sum(hover_durations) / len(hover_durations) / 1000) if hover_durations else 45.0
            attention_span = int(max(15, min(180, avg_hover_sec + (total_clicks * 2) - (total_idles * 3))))

            persistence = 1.0 + (recovered_topics * 0.5) + (total_clicks * 0.05) - (total_idles * 0.1)
            persistence = round(max(0.1, min(5.0, persistence)), 2)

            maturity = 1.0 + (completed_nodes * 0.2) + (persistence * 0.1)
            maturity = round(max(0.5, min(5.0, maturity)), 2)

            now = time.time()
            query_update = """
                UPDATE learning_dna_profiles
                SET attention_span_average_sec = ?, persistence_score = ?, learning_maturity = ?, updated_at = ?
                WHERE user_id = ?
            """
            execute_db(cursor, is_sqlite, query_update, (attention_span, persistence, maturity, now, user_id))
            
            # Fetch curiosity_type and learning_style to use as metadata in ChromaDB
            query_select_profile = "SELECT curiosity_type, learning_style FROM learning_dna_profiles WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_select_profile, (user_id,))
            profile_row = cursor.fetchone()
            curiosity_type = profile_row[0] if profile_row else "Logical-Explorer"
            learning_style = profile_row[1] if profile_row else "Visual"

        # Update ChromaDB vector profiling (outside DB transaction lock)
        if chroma_client:
            try:
                collection = chroma_client.get_or_create_collection("cognitive_dna_profiles")
                embedding = [float(attention_span), float(persistence), float(maturity)]
                collection.upsert(
                    ids=[user_id],
                    embeddings=[embedding],
                    metadatas=[{
                        "curiosity_type": curiosity_type,
                        "learning_style": learning_style,
                        "updated_at": now
                    }]
                )
                logger.info(f"Upserted cognitive profile vector for user {user_id} into ChromaDB: {embedding}")
            except Exception as e:
                logger.warning(f"Failed to save profile vector to ChromaDB: {e}")

        logger.info(f"Evolved learning DNA profile for user: {user_id} -> attention_span={attention_span}s, persistence={persistence}, maturity={maturity}")
        return {
            "status": "success",
            "attention_span": attention_span,
            "persistence_score": persistence,
            "learning_maturity": maturity
        }
    except Exception as e:
        logger.error(f"Error evolving cognitive profile: {e}")
        return {"status": "error", "message": str(e)}


def write_temp_script(code: str, scene_idx: int) -> str:
    animation_file = f"animation_{scene_idx}.py"
    with open(animation_file, "w", encoding="utf-8") as f:
        f.write(code)
    print(f"Wrote file: {animation_file}")
    return animation_file

class StateController:
    """
    State machine that orchestrates the lesson generation pipeline:
    IngestTelemetry -> ClassifyState -> PredictBoredom -> RLBanditSelector -> Storyteller -> MediaGen
    """
    def __init__(self, user_id: str, job_id: str, prompt_text: str):
        self.user_id = user_id
        self.job_id = job_id
        self.prompt_text = prompt_text
        self.state = "IngestTelemetry"
        self.context = {}

    async def run(self):
        while self.state not in ["Completed", "Failed"]:
            logger.info(f"Orchestrator job={self.job_id} running state: {self.state}")
            try:
                if self.state == "IngestTelemetry":
                    await self.node_ingest_telemetry()
                elif self.state == "ClassifyState":
                    await self.node_classify_state()
                elif self.state == "PredictBoredom":
                    await self.node_predict_boredom()
                elif self.state == "RLBanditSelector":
                    await self.node_rl_bandit_selector()
                elif self.state == "Storyteller":
                    await self.node_storyteller()
                elif self.state == "MediaGen":
                    await self.node_media_gen()
            except Exception as e:
                import traceback
                error_details = traceback.format_exc()
                logger.error(f"BACKGROUND TASK ERROR in state {self.state}: {str(e)}\n{error_details}")
                job_store.update(self.job_id, {
                    "status": "failed",
                    "progress": 100,
                    "message": f"Failed in state {self.state}",
                    "error": str(e)
                })
                self.state = "Failed"

    async def node_ingest_telemetry(self):
        job_store.update(self.job_id, {
            "status": "generating",
            "progress": 5,
            "message": "Ingesting telemetry history..."
        })
        ensure_learning_dna_profile(self.user_id)
        # Load user profile from DB to context
        try:
            with get_db_cursor() as (cursor, is_sqlite):
                query = "SELECT curiosity_type, learning_style FROM learning_dna_profiles WHERE user_id = ?"
                execute_db(cursor, is_sqlite, query, (self.user_id,))
                row = cursor.fetchone()
                if row:
                    self.context["curiosity_type"] = row[0]
                    self.context["learning_style"] = row[1]
                else:
                    self.context["curiosity_type"] = "Logical-Explorer"
                    self.context["learning_style"] = "Visual"
        except Exception as e:
            logger.error(f"Error loading profile in IngestTelemetry: {e}")
            self.context["curiosity_type"] = "Logical-Explorer"
            self.context["learning_style"] = "Visual"
        self.state = "ClassifyState"

    async def node_classify_state(self):
        job_store.update(self.job_id, {
            "progress": 10,
            "message": "Evolving cognitive profile..."
        })
        evolve_cognitive_profile(self.user_id)
        self.state = "PredictBoredom"

    async def node_predict_boredom(self):
        job_store.update(self.job_id, {
            "progress": 15,
            "message": "Checking boredom index..."
        })
        boredom_score = calculate_boredom_score(self.user_id)
        self.context["boredom_score"] = boredom_score
        self.state = "RLBanditSelector"

    async def node_rl_bandit_selector(self):
        job_store.update(self.job_id, {
            "progress": 20,
            "message": "Running multi-armed bandit recommendation..."
        })
        
        # Thompson Sampling algorithm
        modalities = ["Visual-Interactive", "Conceptual-Numeric", "Applied-Practical"]
        feedback = {}
        
        # Check Redis cache first
        bandit_weights = None
        if redis_client:
            try:
                cached_weights = redis_client.get(f"bandit:feedback:{self.user_id}")
                if cached_weights:
                    bandit_weights = json.loads(cached_weights.decode('utf-8'))
                    logger.info(f"Loaded Thompson Sampling weights from Redis cache for user {self.user_id}")
            except Exception as e:
                logger.warning(f"Error reading from Redis cache: {e}")

        try:
            with get_db_cursor() as (cursor, is_sqlite):
                if not bandit_weights:
                    bandit_weights = {}
                    for m in modalities:
                        query_pos = """
                            SELECT COUNT(*) FROM recommendation_logs
                            WHERE user_id = ? AND recommended_node_id = ? AND engagement_outcome >= 0.7
                        """
                        execute_db(cursor, is_sqlite, query_pos, (self.user_id, m))
                        pos = cursor.fetchone()[0]
                        
                        query_neg = """
                            SELECT COUNT(*) FROM recommendation_logs
                            WHERE user_id = ? AND recommended_node_id = ? AND engagement_outcome < 0.3
                        """
                        execute_db(cursor, is_sqlite, query_neg, (self.user_id, m))
                        neg = cursor.fetchone()[0]
                        bandit_weights[m] = (pos, neg)
                    
                    # Cache in Redis for 10 minutes (600s)
                    if redis_client:
                        try:
                            redis_client.setex(f"bandit:feedback:{self.user_id}", 600, json.dumps(bandit_weights))
                        except Exception as e:
                            logger.warning(f"Error saving to Redis cache: {e}")

                feedback = bandit_weights

                import random
                sampled_thetas = {}
                for m in modalities:
                    pos, neg = feedback[m]
                    theta = random.betavariate(1 + pos, 1 + neg)
                    sampled_thetas[m] = theta
                    
                selected_modality = max(sampled_thetas, key=sampled_thetas.get)
                self.context["selected_modality"] = selected_modality
                
                # Record recommendation
                query_insert = """
                    INSERT INTO recommendation_logs (
                        user_id, recommended_node_id, filtering_type, emotional_weighting, engagement_outcome, feedback_reward, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """
                execute_db(cursor, is_sqlite, query_insert, (self.user_id, selected_modality, "rl-bandit", 0.5, None, 0.0, time.time()))
                
                # Invalidate Redis cache for user
                if redis_client:
                    try:
                        redis_client.delete(f"bandit:feedback:{self.user_id}")
                    except Exception as e:
                        logger.warning(f"Failed to delete Redis cache: {e}")
                
                logger.info(f"Thompson Sampling selected modality '{selected_modality}' for user '{self.user_id}' with weights {feedback}")
        except Exception as e:
            logger.error(f"Error in Thompson Sampling selection: {e}")
            self.context["selected_modality"] = "Visual-Interactive"
            
        self.state = "Storyteller"

    async def node_storyteller(self):
        job_store.update(self.job_id, {
            "progress": 30,
            "message": f"Storyteller generating {self.context['selected_modality']} content..."
        })
        
        # Classify the input
        classification = classify_input(self.prompt_text)
        audience = classification.get("audience", "college student")
        topic = classification.get("topic", self.prompt_text)
        
        self.context["audience"] = audience
        self.context["topic"] = topic
        
        # Create storyboard with modality customized prompt
        modality = self.context["selected_modality"]
        wikipedia_info = wikipedia.run(topic)
        
        modality_instruction = ""
        if modality == "Visual-Interactive":
            modality_instruction = "\nStyle Guideline: Focus heavily on visual geometries, vector spaces, grid coordinate transformations, and color-coded diagrams. Minimize formulas and focus on interactive animations."
        elif modality == "Conceptual-Numeric":
            modality_instruction = "\nStyle Guideline: Focus on formal equations, numeric calculations, step-by-step mathematical proofs, and code-like programmatic explanations."
        elif modality == "Applied-Practical":
            modality_instruction = "\nStyle Guideline: Emphasize practical applications (e.g. physics, engineering, everyday scenarios), physical forces, and conceptual storytelling examples."

        prompt = STORYBOARD_PROMPT_TEMPLATE.format(
            audience=audience,
            topic=topic + modality_instruction,
            wikipedia_info=wikipedia_info
        )
        
        storyboard_json = generate_response(prompt)
        try:
            storyboard = json.loads(storyboard_json)
        except json.JSONDecodeError as e:
            logger.error(f"Error decoding JSON storyboard: {e}. Received JSON: {storyboard_json}")
            raise ValueError("Failed to generate valid JSON storyboard from AI storyteller.")
            
        if not storyboard or "frames" not in storyboard:
            raise ValueError("Invalid storyboard structure received from AI storyteller.")
            
        self.context["storyboard"] = storyboard
        self.state = "MediaGen"

    async def node_media_gen(self):
        job_store.update(self.job_id, {
            "progress": 40,
            "message": "Starting visual asset compilation..."
        })
        
        storyboard = self.context["storyboard"]
        topic = self.context["topic"]
        audience = self.context["audience"]
        
        result = {
            "metadata": {
                "topic": topic,
                "audience": audience,
                "modality": self.context["selected_modality"]
            },
            "success": True,
            "scenes": []
        }
        
        video_urls = []
        scenes = storyboard.get("frames", [])
        total_scenes = len(scenes)
        
        for idx, frame in enumerate(scenes):
            scene_number = idx + 1
            job_store.update(self.job_id, {
                "message": f"Compiling scene {scene_number} of {total_scenes}...",
                "progress": int(40 + (idx / total_scenes) * 50)
            })
            
            scene_data = {
                "scene_number": scene_number,
                "title": frame["title"],
                "description": frame["description"]
            }
            
            scene = generate_scene(frame["description"])
            if scene:
                if "narration" in scene:
                    scene_data["narration"] = scene["narration"]
                if "animation-description" in scene:
                    scene_data["animation_description"] = scene["animation-description"]
                
                scene_data["assessment"] = {
                    "multiple_choice": {
                        "question": scene.get("multiple-choice-question", ""),
                        "choices": scene.get("multiple-choice-choices", []),
                        "correct_index": scene.get("correct-index", 0)
                    },
                    "free_response": {
                        "question": scene.get("free-response-question", ""),
                        "answer": scene.get("free-response-answer", "")
                    }
                }
                
                scene_data["manim_code"] = generate_animation_code(
                    scene.get("narration", ""), 
                    scene.get("animation-description", ""), 
                    frame["title"],
                    scene_number
                )
            
            # Compile manim script with retry logic
            video_path, success = await compile_scene_with_retry(
                topic=topic,
                scene_idx=scene_number,
                initial_code=scene_data.get("manim_code", ""),
                job_id=self.job_id,
                write_script_fn=write_temp_script,
                run_manim_fn=lambda p: subprocess.run(
                    ["manim", "-pql", "--progress_bar", "none", str(p), f"Scene{scene_number}"],
                    capture_output=True,
                    text=True,
                    timeout=90,
                ),
                placeholder_url=PLACEHOLDER_VIDEO_URL,
            )

            if success:
                mp4_path = f"media/videos/animation_{scene_number}/480p15/Scene{scene_number}.mp4"
                if os.path.exists(mp4_path):
                    file_name = f"{uuid.uuid4()}_Scene{scene_number}.mp4"
                    blob = bucket.blob(file_name)
                    blob.upload_from_filename(mp4_path, content_type="video/mp4")
                    blob.make_public()
                    video_urls.append(blob.public_url)
                    logger.info(f"Successfully uploaded {mp4_path} to Firebase")
                else:
                    logger.warning(f"Rendered video not found at {mp4_path}")
                    video_urls.append(PLACEHOLDER_VIDEO_URL)
            else:
                video_urls.append(video_path)  # already placeholder
                
            result["scenes"].append(scene_data)
            
        job_store.update(self.job_id, {
            "status": "completed",
            "progress": 100,
            "message": "All educational assets and videos generated successfully!",
            "data": result,
            "video_urls": video_urls
        })
        self.state = "Completed"

async def process_data_background(job_id: str, prompt_text: str, user_id: str = "defaultUser"):
    """Background task that runs the StateController loop asynchronously"""
    controller = StateController(user_id, job_id, prompt_text)
    await controller.run()

@app.post("/process-data")
async def index(request: LessonRequest, background_tasks: BackgroundTasks, decoded_token: dict = Depends(verify_firebase_token)):
    """Triggers asynchronous educational generation and video rendering"""
    user_id = decoded_token.get("uid") or "defaultUser"
    topic = request.topic
    job_id = str(uuid.uuid4())
    job_store.create(job_id, {
        "status": "queued",
        "progress": 0,
        "message": "Initializing generation request...",
        "data": None,
        "video_urls": [],
        "error": None
    })
    
    background_tasks.add_task(process_data_background, job_id, topic, user_id)
    return {
        "status": "queued",
        "job_id": job_id,
        "message": "Rendering task has been sent to the background queue."
    }

@app.get("/job-status/{job_id}")
async def get_job_status(job_id: str, user=Depends(verify_firebase_token)):
    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail=f"Job '{job_id}' not found. It may have expired or the server restarted."
        )
    return job

@app.post("/telemetry")
async def receive_telemetry(event: TelemetryEvent, background_tasks: BackgroundTasks, decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    save_telemetry_event(user_id, event)
    background_tasks.add_task(evolve_cognitive_profile, user_id)
    return {"status": "success", "message": "Telemetry received and persisted."}

class NarrationRequest(BaseModel):
    text: str
    companion_type: str

@app.post("/narrate-elevenlabs")
async def narrate_elevenlabs(req: NarrationRequest, decoded_token: dict = Depends(verify_firebase_token)):
    try:
        audio_url = generate_narration(req.text, req.companion_type)
        return {"audioUrl": audio_url}
    except Exception as e:
        logger.error(f"Error in narrate-elevenlabs endpoint: {e}")
        return {"audioUrl": "/narrations/silent_placeholder.mp3"}

class MilestoneRequest(BaseModel):
    milestone_type: str  # biggest_win, failed_concept, recovered_topic, emotional_peak
    concept_id: str
    description: str
    associated_sentiment: float
    mastery_delta: float | None = None

@app.post("/milestones")
async def add_milestone(req: MilestoneRequest, background_tasks: BackgroundTasks, decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            now = time.time()
            query = """
                INSERT INTO emotional_memory_timeline (
                    user_id, milestone_type, concept_id, description, associated_sentiment, mastery_delta, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """
            execute_db(cursor, is_sqlite, query, (
                user_id,
                req.milestone_type,
                req.concept_id,
                req.description,
                req.associated_sentiment,
                req.mastery_delta,
                now
            ))
        background_tasks.add_task(evolve_cognitive_profile, user_id)
        return {"status": "success", "message": "Milestone recorded."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/parent/child-data")
async def get_parent_child_data(decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
        
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            # Fetch profile
            query_profile = """
                SELECT curiosity_type, learning_style, attention_span_average_sec, pacing_preference, motivation_trigger, persistence_score, learning_maturity
                FROM learning_dna_profiles WHERE user_id = ?
            """
            execute_db(cursor, is_sqlite, query_profile, (user_id,))
            profile_row = cursor.fetchone()
            profile = None
            if profile_row:
                profile = {
                    "curiosity_type": profile_row[0],
                    "learning_style": profile_row[1],
                    "attention_span_average_sec": profile_row[2],
                    "pacing_preference": profile_row[3],
                    "motivation_trigger": profile_row[4],
                    "persistence_score": profile_row[5],
                    "learning_maturity": profile_row[6]
                }

            # Fetch telemetry events count
            query_telemetry = "SELECT COUNT(*) FROM telemetry_events WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_telemetry, (user_id,))
            telemetry_count = cursor.fetchone()[0]

            # Fetch milestones
            query_milestones = """
                SELECT milestone_type, concept_id, description, associated_sentiment, mastery_delta, created_at
                FROM emotional_memory_timeline WHERE user_id = ? ORDER BY created_at DESC
            """
            execute_db(cursor, is_sqlite, query_milestones, (user_id,))
            milestone_rows = cursor.fetchall()
            milestones = []
            for r in milestone_rows:
                milestones.append({
                    "milestone_type": r[0],
                    "concept_id": r[1],
                    "description": r[2],
                    "associated_sentiment": r[3],
                    "mastery_delta": r[4],
                    "created_at": r[5]
                })

            # Fetch world state
            query_world = """
                SELECT world_seed, current_dimension, unlocked_regions, world_lore_summary, companion_relationship_score
                FROM adaptive_worlds WHERE user_id = ?
            """
            execute_db(cursor, is_sqlite, query_world, (user_id,))
            world_row = cursor.fetchone()
            world = None
            if world_row:
                regions_data = world_row[2]
                if isinstance(regions_data, str):
                    regions_list = json.loads(regions_data)
                else:
                    regions_list = regions_data
                world = {
                    "world_seed": world_row[0],
                    "current_dimension": world_row[1],
                    "unlocked_regions": regions_list,
                    "world_lore_summary": world_row[3],
                    "companion_relationship_score": world_row[4]
                }

        return {
            "profile": profile,
            "telemetry_count": telemetry_count,
            "milestones": milestones,
            "world": world
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/parent/child-data")
async def delete_parent_child_data(decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")

    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query_del_profile = "DELETE FROM learning_dna_profiles WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_del_profile, (user_id,))
            
            query_del_telemetry = "DELETE FROM telemetry_events WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_del_telemetry, (user_id,))
            
            query_del_milestones = "DELETE FROM emotional_memory_timeline WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_del_milestones, (user_id,))
            
            query_del_world = "DELETE FROM adaptive_worlds WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_del_world, (user_id,))
            
        logger.info(f"Purged all child data from database for child: {user_id}")
        return {"status": "success", "message": "All child data has been purged successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def initialize_adaptive_world(user_id: str, curiosity_type: str) -> None:
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query_check = "SELECT 1 FROM adaptive_worlds WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_check, (user_id,))
            if cursor.fetchone():
                return

            seed = f"seed_{uuid.uuid4().hex[:8]}"
            
            if curiosity_type == "Logical-Explorer":
                region = "Valley of Numbers"
                lore = "A realm of mathematical geometries and code-forged gates where theorems come alive as starry patterns."
            elif curiosity_type == "Creative-Writer":
                region = "Starry Spire"
                lore = "A sanctuary of floating paragraphs and celestial constellation books written by starry dragons."
            else:
                region = "Chromatic Reef"
                lore = "An underwater canvas of bioluminescent colors and coral fractals designed by mermaid artists."

            query_insert = """
                INSERT INTO adaptive_worlds (
                    user_id, world_seed, current_dimension, unlocked_regions, world_lore_summary,
                    companion_relationship_score, last_updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """
            # unlocked_regions is text/json
            regions_val = json.dumps([region])
            execute_db(cursor, is_sqlite, query_insert, (
                user_id,
                seed,
                "Genesis Prime",
                regions_val,
                lore,
                10,
                time.time()
            ))
            logger.info(f"Initialized adaptive world for user: {user_id} with region: {region}")
    except Exception as e:
        logger.error(f"Error initializing adaptive world: {e}")

class UpdateProfileRequest(BaseModel):
    curiosity_type: str
    learning_style: str
    pacing_preference: str = "medium"
    motivation_trigger: str

@app.post("/profile/update")
async def update_profile(req_body: UpdateProfileRequest, background_tasks: BackgroundTasks, decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            now = time.time()
            query_check = "SELECT 1 FROM learning_dna_profiles WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_check, (user_id,))
            exists = cursor.fetchone()
            if exists:
                query_update = """
                    UPDATE learning_dna_profiles
                    SET curiosity_type = ?, learning_style = ?, pacing_preference = ?, motivation_trigger = ?, updated_at = ?
                    WHERE user_id = ?
                """
                execute_db(cursor, is_sqlite, query_update, (req_body.curiosity_type, req_body.learning_style, req_body.pacing_preference, req_body.motivation_trigger, now, user_id))
            else:
                query_insert = """
                    INSERT INTO learning_dna_profiles (
                        user_id, curiosity_type, learning_style, pacing_preference, motivation_trigger,
                        attention_span_average_sec, persistence_score, learning_maturity, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 45, 1.0, 1.0, ?, ?)
                """
                execute_db(cursor, is_sqlite, query_insert, (user_id, req_body.curiosity_type, req_body.learning_style, req_body.pacing_preference, req_body.motivation_trigger, now, now))
        
        background_tasks.add_task(initialize_adaptive_world, user_id, req_body.curiosity_type)
        return {"status": "success", "message": "Learning DNA profile updated successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/profile")
async def get_profile(decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query = "SELECT curiosity_type, learning_style, attention_span_average_sec, pacing_preference, motivation_trigger, persistence_score, learning_maturity FROM learning_dna_profiles WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query, (user_id,))
            row = cursor.fetchone()
            if not row:
                return {"exists": False}
            
            return {
                "exists": True,
                "profile": {
                    "curiosity_type": row[0],
                    "learning_style": row[1],
                    "attention_span_average_sec": row[2],
                    "pacing_preference": row[3],
                    "motivation_trigger": row[4],
                    "persistence_score": row[5],
                    "learning_maturity": row[6]
                }
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/world/state")
async def get_world_state(decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query = """
                SELECT world_seed, current_dimension, unlocked_regions, world_lore_summary, companion_relationship_score
                FROM adaptive_worlds WHERE user_id = ?
            """
            execute_db(cursor, is_sqlite, query, (user_id,))
            row = cursor.fetchone()
            if not row:
                return {"exists": False}
                
            regions_data = row[2]
            if isinstance(regions_data, str):
                regions_list = json.loads(regions_data)
            else:
                regions_list = regions_data
                
            return {
                "exists": True,
                "world": {
                    "world_seed": row[0],
                    "current_dimension": row[1],
                    "unlocked_regions": regions_list,
                    "world_lore_summary": row[3],
                    "companion_relationship_score": row[4]
                }
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def calculate_boredom_score(user_id: str) -> float:
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query = """
                SELECT event_type, interaction_speed_ms, hover_duration_ms, idle_before_action_ms, response_latency_ms, sentiment_score
                FROM telemetry_events
                WHERE user_id = ?
                ORDER BY recorded_at DESC
                LIMIT 30
            """
            execute_db(cursor, is_sqlite, query, (user_id,))
            events = cursor.fetchall()
            
            if not events:
                return 0.1

            total_clicks = sum(1 for e in events if e[0] == 'click')
            total_idles = sum(1 for e in events if e[0] == 'idle')
            
            speeds = [e[1] for e in events if e[0] == 'click' and e[1] is not None]
            avg_speed = sum(speeds) / len(speeds) if speeds else 0
            
            idle_gaps = [e[3] for e in events if e[3] is not None]
            avg_idle_ms = sum(idle_gaps) / len(idle_gaps) if idle_gaps else 0

            latencies = [e[4] for e in events if e[4] is not None]
            avg_latency_ms = sum(latencies) / len(latencies) if latencies else 0

            sentiments = [e[5] for e in events if e[5] is not None]
            avg_sentiment = sum(sentiments) / len(sentiments) if sentiments else 0.0

            score = 0.1
            if total_clicks > 12:
                score += 0.3
            
            if avg_idle_ms > 10000:
                score += 0.3
            elif avg_idle_ms > 5000:
                score += 0.15

            if avg_latency_ms > 15000:
                score += 0.2
                
            if avg_speed > 2500:
                score += 0.15

            if avg_sentiment < -0.4:
                score += 0.2
            elif avg_sentiment > 0.4:
                score -= 0.15

            return round(max(0.0, min(1.0, score)), 2)
    except Exception as e:
        logger.error(f"Error calculating boredom score: {e}")
        return 0.1

@app.get("/boredom-check")
async def boredom_check(decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    
    score = calculate_boredom_score(user_id)
    return {"boredom_score": score, "requires_intervention": score >= 0.7}

class CompanionScoreRequest(BaseModel):
    relationship_delta: int
    unlock_region: str | None = None

@app.post("/world/companion")
async def update_companion_and_world(req: CompanionScoreRequest, decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query = "SELECT companion_relationship_score, unlocked_regions FROM adaptive_worlds WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query, (user_id,))
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="World state not found for user. Complete onboarding first.")
            
            curr_score = row[0]
            regions_data = row[1]
            if isinstance(regions_data, str):
                regions = json.loads(regions_data)
            else:
                regions = regions_data
                
            new_score = max(1, min(100, curr_score + req.relationship_delta))
            
            if req.unlock_region and req.unlock_region not in regions:
                regions.append(req.unlock_region)
                
            regions_value = json.dumps(regions) if is_sqlite or isinstance(regions_data, str) else regions
            
            query_update = """
                UPDATE adaptive_worlds
                SET companion_relationship_score = ?, unlocked_regions = ?, last_updated_at = ?
                WHERE user_id = ?
            """
            execute_db(cursor, is_sqlite, query_update, (new_score, regions_value, time.time(), user_id))
            
            return {
                "status": "success",
                "relationship_score": new_score,
                "unlocked_regions": regions
            }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class XPRequest(BaseModel):
    xp_delta: int
    source_type: str

def add_xp_log(user_id: str, xp_delta: int, source_type: str) -> int:
    """Awards XP to user, updates database, and refreshes Redis sorted set."""
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            # Insert log
            query_insert = """
                INSERT INTO xp_logs (user_id, xp_delta, source_type, created_at)
                VALUES (?, ?, ?, ?)
            """
            execute_db(cursor, is_sqlite, query_insert, (user_id, xp_delta, source_type, time.time()))
            
            # Compute total XP
            query_sum = "SELECT SUM(xp_delta) FROM xp_logs WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_sum, (user_id,))
            total_xp = cursor.fetchone()[0] or 0
            
        # Push to Redis leaderboard sorted set
        if redis_client:
            try:
                redis_client.zadd("leaderboard:global", {user_id: float(total_xp)})
                logger.info(f"Updated Redis leaderboard for user {user_id} with score {total_xp}")
            except Exception as e:
                logger.warning(f"Failed to update Redis leaderboard: {e}")
                
        return total_xp
    except Exception as e:
        logger.error(f"Error adding XP log: {e}")
        return 0

@app.post("/profile/xp")
async def award_xp(req: XPRequest, decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    
    total_xp = add_xp_log(user_id, req.xp_delta, req.source_type)
    return {"status": "success", "total_xp": total_xp, "level": int(total_xp // 100) + 1}

@app.get("/leaderboard")
async def get_leaderboard(decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
        
    leaderboard = []
    user_rank = 0
    user_score = 0
    
    # Try fetching from Redis first
    redis_success = False
    if redis_client:
        try:
            raw_scores = redis_client.zrevrange("leaderboard:global", 0, 9, withscores=True)
            for rank_idx, (member, score) in enumerate(raw_scores):
                mb_str = member.decode('utf-8') if isinstance(member, bytes) else str(member)
                leaderboard.append({
                    "user_id": mb_str,
                    "score": int(score),
                    "rank": rank_idx + 1
                })
            
            rank_zero = redis_client.zrevrank("leaderboard:global", user_id)
            if rank_zero is not None:
                user_rank = rank_zero + 1
                user_score = int(redis_client.zscore("leaderboard:global", user_id) or 0)
            else:
                user_rank = 0
                user_score = 0
            redis_success = True
        except Exception as e:
            logger.warning(f"Failed to read leaderboard from Redis: {e}. Falling back to DB.")
            leaderboard = []
            
    # Fallback to database if Redis failed or is offline
    if not redis_success:
        try:
            with get_db_cursor() as (cursor, is_sqlite):
                query_top10 = """
                    SELECT user_id, SUM(xp_delta) as total_xp 
                    FROM xp_logs 
                    GROUP BY user_id 
                    ORDER BY total_xp DESC 
                    LIMIT 10
                """
                execute_db(cursor, is_sqlite, query_top10)
                rows = cursor.fetchall()
                for rank_idx, r in enumerate(rows):
                    leaderboard.append({
                        "user_id": r[0],
                        "score": r[1],
                        "rank": rank_idx + 1
                    })
                
                query_user_score = "SELECT SUM(xp_delta) FROM xp_logs WHERE user_id = ?"
                execute_db(cursor, is_sqlite, query_user_score, (user_id,))
                user_score = cursor.fetchone()[0] or 0
                
                query_user_rank = """
                    SELECT COUNT(distinct user_id) FROM (
                        SELECT user_id, SUM(xp_delta) as total_xp 
                        FROM xp_logs 
                        GROUP BY user_id
                    ) temp
                    WHERE total_xp > (SELECT COALESCE(SUM(xp_delta), 0) FROM xp_logs WHERE user_id = ?)
                """
                execute_db(cursor, is_sqlite, query_user_rank, (user_id,))
                user_rank = (cursor.fetchone()[0] or 0) + 1
        except Exception as e:
            logger.error(f"Failed to retrieve leaderboard from database: {e}")
            raise HTTPException(status_code=500, detail="Could not compile leaderboard.")

    return {
        "leaderboard": leaderboard,
        "user_rank": user_rank,
        "user_score": user_score
    }

class SkillUnlockRequest(BaseModel):
    skill_id: str

@app.get("/skills")
async def get_unlocked_skills(decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
        
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            query = "SELECT skill_id, unlocked_at FROM skills_unlocked WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query, (user_id,))
            rows = cursor.fetchall()
            skills = [{"skill_id": r[0], "unlocked_at": r[1]} for r in rows]
            return {"skills": skills}
    except Exception as e:
        logger.error(f"Error fetching skills: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/skills/unlock")
async def unlock_skill(req: SkillUnlockRequest, decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
        
    try:
        with get_db_cursor() as (cursor, is_sqlite):
            now = time.time()
            query = "INSERT INTO skills_unlocked (user_id, skill_id, unlocked_at) VALUES (?, ?, ?)"
            execute_db(cursor, is_sqlite, query, (user_id, req.skill_id, now))
        return {"status": "success", "skill_id": req.skill_id, "unlocked_at": now}
    except Exception as e:
        if "UNIQUE constraint failed" in str(e) or "duplicate key value" in str(e) or "PrimaryKeyViolation" in str(e):
            return {"status": "success", "skill_id": req.skill_id, "message": "Already unlocked"}
        logger.error(f"Error unlocking skill: {e}")
        raise HTTPException(status_code=500, detail=str(e))

from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors

def generate_parent_pdf_report(user_id: str, stats: dict) -> str:
    reports_dir = os.path.join(os.path.dirname(__file__), "reports")
    os.makedirs(reports_dir, exist_ok=True)
    pdf_path = os.path.join(reports_dir, f"report_{user_id}.pdf")
    
    doc = SimpleDocTemplate(pdf_path, pagesize=letter, rightMargin=36, leftMargin=36, topMargin=36, bottomMargin=36)
    story = []
    
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        'ReportTitle',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=colors.HexColor('#4F46E5'),
        spaceAfter=15
    )
    h2_style = ParagraphStyle(
        'SectionHeader',
        parent=styles['Heading2'],
        fontSize=16,
        textColor=colors.HexColor('#1E293B'),
        spaceBefore=10,
        spaceAfter=10
    )
    body_style = ParagraphStyle(
        'ReportBody',
        parent=styles['BodyText'],
        fontSize=11,
        textColor=colors.HexColor('#475569'),
        spaceAfter=8
    )
    
    # Header
    story.append(Paragraph("Lerno.ai — Weekly Learning Analytics Report", title_style))
    story.append(Paragraph(f"User ID: {user_id}", body_style))
    story.append(Paragraph(f"Date: {time.strftime('%Y-%m-%d %H:%M:%S')}", body_style))
    story.append(Spacer(1, 15))
    
    # Cognitive DNA Summary
    story.append(Paragraph("Cognitive Profile & Evolution Summary", h2_style))
    story.append(Paragraph(f"Curiosity Type: {stats.get('curiosity_type', 'N/A')}", body_style))
    story.append(Paragraph(f"Learning Style: {stats.get('learning_style', 'N/A')}", body_style))
    story.append(Paragraph(f"Current Learning Maturity Index: {stats.get('learning_maturity', 1.0):.2f}", body_style))
    story.append(Paragraph(f"Persistence Score: {stats.get('persistence_score', 1.0):.2f}", body_style))
    story.append(Spacer(1, 10))
    
    # Telemetry Summary
    story.append(Paragraph("Behavioral & Telemetry Analytics", h2_style))
    story.append(Paragraph(f"Total Learning Interactions: {stats.get('total_interactions', 0)}", body_style))
    story.append(Paragraph(f"Average Attention Span: {stats.get('attention_span', 45)} seconds", body_style))
    story.append(Paragraph(f"Consistency Rating: {stats.get('consistency_rating', 0)}%", body_style))
    story.append(Paragraph(f"Focus Index: {stats.get('focus_index', 0)}/10", body_style))
    story.append(Spacer(1, 10))
    
    # Burnout Alert
    story.append(Paragraph("Burnout & Engagement Risk Analysis", h2_style))
    burnout_status = "High Risk - Companion intervention recommended to adjust pacing." if stats.get('burnout_flag', False) else "Low Risk - Healthy learning session distribution."
    story.append(Paragraph(f"Burnout Warning: {burnout_status}", body_style))
    story.append(Spacer(1, 10))
    
    # Table of Milestones
    story.append(Paragraph("Recent Educational Milestones", h2_style))
    milestones = stats.get('recent_milestones', [])
    if milestones:
        data = [["Milestone Type", "Concept ID", "Sentiment", "Description"]]
        for m in milestones[:5]:
            data.append([
                m.get('milestone_type', ''),
                m.get('concept_id', ''),
                f"{m.get('associated_sentiment', 0.0):.2f}",
                m.get('description', '')
            ])
        t = Table(data, colWidths=[100, 100, 70, 250])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#F1F5F9')),
            ('TEXTCOLOR', (0,0), (-1,0), colors.HexColor('#1E293B')),
            ('ALIGN', (0,0), (-1,-1), 'LEFT'),
            ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
            ('BOTTOMPADDING', (0,0), (-1,0), 6),
            ('BACKGROUND', (0,1), (-1,-1), colors.HexColor('#F8FAFC')),
            ('GRID', (0,0), (-1,-1), 1, colors.HexColor('#E2E8F0')),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
            ('FONTSIZE', (0,0), (-1,-1), 9),
        ]))
        story.append(t)
    else:
        story.append(Paragraph("No milestones recorded in this session window.", body_style))
        
    doc.build(story)
    return pdf_path

@app.get("/parent/analytics/report")
async def get_parent_analytics_report(decoded_token: dict = Depends(verify_firebase_token)):
    user_id = decoded_token.get("uid")
    if not user_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
        
    try:
        stats = {}
        with get_db_cursor() as (cursor, is_sqlite):
            query_profile = """
                SELECT curiosity_type, learning_style, attention_span_average_sec, persistence_score, learning_maturity
                FROM learning_dna_profiles WHERE user_id = ?
            """
            execute_db(cursor, is_sqlite, query_profile, (user_id,))
            profile_row = cursor.fetchone()
            if profile_row:
                stats['curiosity_type'] = profile_row[0]
                stats['learning_style'] = profile_row[1]
                stats['attention_span'] = profile_row[2]
                stats['persistence_score'] = profile_row[3]
                stats['learning_maturity'] = profile_row[4]
            else:
                stats['curiosity_type'] = "Logical-Explorer"
                stats['learning_style'] = "Visual"
                stats['attention_span'] = 45
                stats['persistence_score'] = 1.0
                stats['learning_maturity'] = 1.0

            query_tel_count = "SELECT COUNT(*) FROM telemetry_events WHERE user_id = ?"
            execute_db(cursor, is_sqlite, query_tel_count, (user_id,))
            stats['total_interactions'] = cursor.fetchone()[0]

            query_hover = "SELECT AVG(hover_duration_ms) FROM telemetry_events WHERE user_id = ? AND event_type = 'hover'"
            execute_db(cursor, is_sqlite, query_hover, (user_id,))
            avg_hover_ms = cursor.fetchone()[0] or 12000
            stats['focus_index'] = min(10, int(avg_hover_ms / 2000))

            stats['consistency_rating'] = min(100, int(stats['total_interactions'] * 2.5)) if stats['total_interactions'] > 0 else 0

            score = calculate_boredom_score(user_id)
            stats['burnout_flag'] = score >= 0.7

            query_milestones = """
                SELECT milestone_type, concept_id, associated_sentiment, description, created_at
                FROM emotional_memory_timeline WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
            """
            execute_db(cursor, is_sqlite, query_milestones, (user_id,))
            rows = cursor.fetchall()
            stats['recent_milestones'] = [
                {
                    "milestone_type": r[0],
                    "concept_id": r[1],
                    "associated_sentiment": r[2],
                    "description": r[3],
                    "created_at": r[4]
                }
                for r in rows
            ]

        pdf_path = generate_parent_pdf_report(user_id, stats)
        
        return {
            "status": "success",
            "report_url": f"/reports/report_{user_id}.pdf",
            "analytics": {
                "curiosity_type": stats['curiosity_type'],
                "learning_style": stats['learning_style'],
                "learning_maturity": stats['learning_maturity'],
                "persistence_score": stats['persistence_score'],
                "focus_index": stats['focus_index'],
                "consistency_rating": stats['consistency_rating'],
                "total_interactions": stats['total_interactions'],
                "burnout_flag": stats['burnout_flag']
            }
        }
    except Exception as e:
        logger.error(f"Failed to compile weekly parent report: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class CooperativeRewardsRequest(BaseModel):
    user_ids: list[str]

@app.post("/multiplayer/rewards")
async def award_cooperative_rewards(req: CooperativeRewardsRequest, decoded_token: dict = Depends(verify_firebase_token)):
    caller_id = decoded_token.get("uid")
    if not caller_id:
        raise HTTPException(status_code=401, detail="User ID not found in token")
        
    try:
        results = {}
        for uid in req.user_ids:
            total_xp = add_xp_log(uid, 100, "coop_boss_defeat")
            results[uid] = {
                "total_xp": total_xp,
                "level": int(total_xp // 100) + 1
            }
        return {"status": "success", "rewards": results}
    except Exception as e:
        logger.error(f"Error awarding cooperative rewards: {e}")
        raise HTTPException(status_code=500, detail=str(e))