import os
import time
import logging
import hashlib
import base64
from pathlib import Path
import requests
from dotenv import load_dotenv

# Setup logger
logger = logging.getLogger("narration_service")
logger.setLevel(logging.INFO)

# Resolve paths
backend_dir = Path(__file__).resolve().parent.parent
root_dir = backend_dir.parent

# Load dotenv files
load_dotenv(dotenv_path=backend_dir / ".env")
load_dotenv(dotenv_path=root_dir / ".env")

VOICE_REGISTRY = {
    "spark_owl": {
        "name": "Samarth – Educational Documentary",
        "voice_id": os.getenv("VOICE_SPARK_OWL"),
    },
    "ember_dragon": {
        "name": "Devi – Encouraging and Motivating",
        "voice_id": os.getenv("VOICE_EMBER_DRAGON"),
    },
    "aqua_mermaid": {
        "name": "Srikant – Friendly, Helpful and Neutral",
        "voice_id": os.getenv("VOICE_AQUA_MERMAID"),
    },
}

NARRATIONS_DIR = backend_dir / "narrations"
os.makedirs(NARRATIONS_DIR, exist_ok=True)

def create_silent_placeholder_if_missing(file_path: Path):
    """
    Creates a minimal, valid 1-second silent MP3 placeholder file.
    """
    if not file_path.exists():
        # Minimal valid 1-second silent MP3 base64
        silent_b64 = (
            "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGFtZTMuMTAwZXJyb3IAAAAAAAAAAAAA"
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV"
            "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV"
            "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV"
            "AAAAAAAAAAAAAAD/42QAAAAAAAAAAAAA"
        )
        try:
            os.makedirs(file_path.parent, exist_ok=True)
            with open(file_path, "wb") as f:
                f.write(base64.b64decode(silent_b64))
            logger.info("Successfully created silent fallback MP3 placeholder.")
        except Exception as e:
            logger.error(f"Failed to create silent fallback MP3 file: {e}")

def get_voice_id(companion_type: str) -> str:
    """
    Resolves the companion type to the corresponding voice ID.
    Supports flexible naming (e.g. 'Spark Owl', 'spark_owl', 'spark-owl').
    """
    normalized = companion_type.lower().replace(" ", "_").replace("-", "_")
    profile = VOICE_REGISTRY.get(normalized)
    if not profile:
        raise ValueError(f"Invalid companion type requested: '{companion_type}'")
    
    voice_id = profile["voice_id"]
    if not voice_id:
        raise ValueError(f"Voice ID not configured for companion: '{companion_type}'")
    
    return voice_id

def stream_narration(text: str, companion_type: str):
    """
    Generator yielding audio chunks directly from the ElevenLabs API.
    Enables future WebSocket streaming without rewriting the service layer.
    """
    voice_id = get_voice_id(companion_type)
    api_key = os.getenv("ELEVENLABS_API_KEY")
    
    if not api_key:
        raise ValueError("ELEVENLABS_API_KEY is not configured in the environment.")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json"
    }
    payload = {
        "text": text,
        "model_id": "eleven_monolingual_v1",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75
        }
    }

    response = requests.post(url, json=payload, headers=headers, stream=True, timeout=15)
    
    # Handle status errors gracefully
    if response.status_code == 401:
        raise ValueError("ElevenLabs unauthorized: Invalid API key.")
    elif response.status_code == 429:
        raise ValueError("ElevenLabs quota exceeded: Limit reached.")
    elif response.status_code != 200:
        raise ValueError(f"ElevenLabs API failed with status {response.status_code}: {response.text}")

    for chunk in response.iter_content(chunk_size=4096):
        if chunk:
            yield chunk

def generate_narration(text: str, companion_type: str) -> str:
    """
    Generates a local MP3 file for a narration request.
    Implements MD5-based caching, performance logging, and robust fallbacks.
    """
    silent_placeholder_path = NARRATIONS_DIR / "silent_placeholder.mp3"

    try:
        voice_id = get_voice_id(companion_type)
    except ValueError as e:
        logger.error(f"Narration registry error: {e}. Triggering fallback.")
        create_silent_placeholder_if_missing(silent_placeholder_path)
        return "/narrations/silent_placeholder.mp3"

    # Compute a unique hash key for caching to save API quota
    text_hash = hashlib.md5((text + "_" + voice_id).encode("utf-8")).hexdigest()
    filename = f"{text_hash}.mp3"
    file_path = NARRATIONS_DIR / filename

    if file_path.exists():
        logger.info(f"Returning cached narration for '{companion_type}' (hash: {text_hash})")
        return f"/narrations/{filename}"

    logger.info(f"Generating new ElevenLabs narration for '{companion_type}'...")
    start_time = time.time()

    try:
        # Write streaming chunks to the local file
        with open(file_path, "wb") as f:
            for chunk in stream_narration(text, companion_type):
                f.write(chunk)
        
        latency = time.time() - start_time
        logger.info(f"Successfully generated narration file '{filename}'. Latency: {latency:.2f}s")
        return f"/narrations/{filename}"

    except Exception as e:
        latency = time.time() - start_time
        logger.error(f"ElevenLabs narration failed after {latency:.2f}s. Error: {e}. Triggering fallback.")
        
        # Clean up partial/corrupt file if created
        if file_path.exists():
            try:
                os.remove(file_path)
            except Exception as cleanup_err:
                logger.warning(f"Failed to remove partial narration file: {cleanup_err}")

        create_silent_placeholder_if_missing(silent_placeholder_path)
        return "/narrations/silent_placeholder.mp3"
