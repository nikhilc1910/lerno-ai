import json
import re
import os
import ast
import hashlib
from pathlib import Path
import logging
import threading
import time
import anthropic
from dotenv import load_dotenv
from pydantic import BaseModel, Field, field_validator
from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import PromptTemplate
from langchain_community.utilities import WikipediaAPIWrapper
import subprocess
import firebase_admin
from firebase_admin import credentials, storage, auth
import uuid

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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


async def ask_claude_to_fix_manim(
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

    resp = anthropic_client.messages.create(
        model="claude-3-7-sonnet-20250219",
        max_tokens=2500,
        messages=[{"role": "user", "content": fix_prompt}],
    )
    raw = resp.content[0].text.strip()
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
                code = await ask_claude_to_fix_manim(
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
            code = await ask_claude_to_fix_manim(topic, scene_idx, code, error_text, attempt)

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

load_dotenv()
firebase_creds_path = os.getenv("FIREBASE_CREDENTIALS_JSON", "lerno-998e4-firebase-adminsdk-fbsvc-736e959000.json")
cred = credentials.Certificate(firebase_creds_path)
storage_bucket = os.getenv("FIREBASE_STORAGE_BUCKET", "lerno-998e4.firebasestorage.app")
firebase_admin.initialize_app(cred, {"storageBucket": storage_bucket})
# For Storing Videos and manim Generation
bucket = storage.bucket()

security = HTTPBearer()

async def verify_firebase_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        decoded_token = auth.verify_id_token(token)
        return decoded_token
    except Exception as e:
        raise HTTPException(
            status_code=401,
            detail=f"Invalid or expired Firebase ID token: {str(e)}"
        )

anthropic_api_key = os.getenv("ANTHROPIC_API_KEY")
google_api_key = os.getenv("GOOGLE_API_KEY")

if not anthropic_api_key:
    raise ValueError("ANTHROPIC_API_KEY not found in environment variables or .env file")

anthropic_client = anthropic.Anthropic(api_key=anthropic_api_key)
PLACEHOLDER_VIDEO_URL = "https://storage.googleapis.com/lerno-998e4.appspot.com/placeholder.mp4"

model = ChatAnthropic(
    model_name="claude-3-7-sonnet-20250219",
    anthropic_api_key=anthropic_api_key,
    temperature=0.7,
    max_tokens=4000
)

wikipedia = WikipediaAPIWrapper(top_k_results=2)

use_gemini = False
if google_api_key:
    try:
        from langchain_google_genai import ChatGoogleGenerativeAI
        gemini_model = ChatGoogleGenerativeAI(model="gemini-2.0-flash", google_api_key=google_api_key)
        use_gemini = True
    except (ImportError, Exception) as e:
        print(f"Failed to initialize Gemini: {e}")
        print("Will use Claude for classification instead.")

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

def generate_response(prompt):
    """Extract JSON from Claude's response"""
    message = model.invoke(prompt)
    text = message.content
    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    if json_match:
        return json_match.group(0)
    else:
        return ""

def generate_response_raw(prompt):
    """Get raw text response from Claude"""
    message = model.invoke(prompt)
    return message.content.strip()

def classify_input(user_input):
    """Classifies user input into topic and audience using Gemini if available, otherwise uses Claude."""
    if use_gemini:
        try:
            prompt = f"""Classify the following input into a topic and audience. If no audience is provided, default to college student.
            Return the response as a JSON object with "topic" and "audience" as keys.

            Input: {user_input}
            Output:
            """
            response = gemini_model.invoke(prompt)
            result = json.loads(response.content)
            return result
        except Exception as e:
            print(f"Error using Gemini for classification: {e}")
    
    prompt = f"""Classify the following input into a topic to explain and an audience level. If no audience level is explicitly mentioned, default to "college student".

    Input: "{user_input}"

    Return ONLY a JSON object with "topic" and "audience" as keys. For example:
    {{
        "topic": "quantum physics",
        "audience": "high school students"
    }}
    """
    
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
        print(f"Error classifying input: {e}")
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


def write_temp_script(code: str, scene_idx: int) -> str:
    animation_file = f"animation_{scene_idx}.py"
    with open(animation_file, "w", encoding="utf-8") as f:
        f.write(code)
    print(f"Wrote file: {animation_file}")
    return animation_file

async def process_data_background(job_id: str, prompt_text: str):
    """Background task to generate and render Manim videos asynchronously"""
    job_store.update(job_id, {
        "status": "generating",
        "progress": 15,
        "message": "Generating storyboard & scripts..."
    })
    
    try:
        # Step 1: Generate storyboard & educational structure
        result = generate_educational_content(prompt_text)
        if not result or not result.get("success"):
            raise ValueError("Failed to generate lesson storyboard and structure from LLM.")
        
        job_store.update(job_id, {
            "data": result,
            "status": "rendering",
            "progress": 40,
            "message": "Starting Manim animation compilation..."
        })
        
        video_urls = []
        scenes = result.get("scenes", [])
        total_scenes = len(scenes)
        
        topic = result.get("metadata", {}).get("topic", prompt_text)

        # Step 2: Render each scene's Manim animation sequentially
        for idx, scene in enumerate(scenes):
            scene_number = scene.get("scene_number", idx + 1)
            job_store.update(job_id, {
                "message": f"Compiling scene {scene_number} of {total_scenes}...",
                "progress": int(40 + (idx / total_scenes) * 50)
            })
            
            manim_code = scene.get("manim_code", "No Manim code generated")
            
            video_path, success = await compile_scene_with_retry(
                topic=topic,
                scene_idx=scene_number,
                initial_code=manim_code,
                job_id=job_id,
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
                    print(f"Successfully uploaded {mp4_path} to Firebase")
                else:
                    print(f"Rendered video not found at {mp4_path}")
            else:
                video_urls.append(video_path)  # already placeholder
        
        job_store.update(job_id, {
            "status": "completed",
            "progress": 100,
            "message": "All educational assets and videos generated successfully!",
            "video_urls": video_urls
        })
        
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"BACKGROUND TASK ERROR: {str(e)}")
        print(f"TRACEBACK: {error_details}")
        job_store.update(job_id, {
            "status": "failed",
            "progress": 100,
            "message": "Generation failed",
            "error": str(e)
        })

@app.post("/process-data")
async def index(request: LessonRequest, background_tasks: BackgroundTasks, decoded_token: dict = Depends(verify_firebase_token)):
    """Triggers asynchronous educational generation and video rendering"""
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
    
    background_tasks.add_task(process_data_background, job_id, topic)
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