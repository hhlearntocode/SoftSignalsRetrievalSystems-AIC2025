from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import sqlite3
import numpy as np
import json
import os
import io
import time
from PIL import Image
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, CLIPProcessor, CLIPModel
import faiss
from typing import List, Optional
from googletrans import Translator

# from pydantic import BaseModel  # Not needed since we use plain dicts
import uvicorn

# Configuration - Updated to match file 2's database structure
DATABASE_FILE = "D:/keyframe_embeddings_clip.db"
FAISS_INDEX_FILE = "D:/keyframe_faiss_clip.index"
FAISS_ID_MAP_FILE = "D:/keyframe_faiss_map_clip.json"
EMBEDDING_DIM = 1280  # Adjust based on your embeddings
CLIP_MODEL_NAME = "laion/CLIP-ViT-bigG-14-laion2B-39B-b160k"
KEYWORD_PARSER_MODEL = None  # "Qwen/Qwen3-4B-Instruct-2507"

app = FastAPI(title="Image Retrieval API", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables
clip_model = None
clip_processor = None
faiss_index = None
faiss_id_map = None
translator = None
device = "cuda" if torch.cuda.is_available() else "cpu"
video_embeddings_cache = {}  # Cache for video-specific embeddings

# We'll use plain dictionaries instead of Pydantic models for response data
# to avoid serialization issues


# Database utilities
def adapt_array(arr):
    return arr.tobytes()


def convert_array(text):
    return np.frombuffer(text, dtype=np.float32)


sqlite3.register_adapter(np.ndarray, adapt_array)
sqlite3.register_converter("array", convert_array)


def get_db_connection():
    conn = sqlite3.connect(DATABASE_FILE, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    return conn


# Model loading functions
def load_models():
    global clip_model, clip_processor
    global llm_model, llm_tokenizer
    try:
        print(f"Loading CLIP model: {CLIP_MODEL_NAME}")
        clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
        clip_model = CLIPModel.from_pretrained(CLIP_MODEL_NAME)
        clip_model = clip_model.to(device)
        clip_model.eval()
        print(f"CLIP model loaded successfully on {device}")
        if KEYWORD_PARSER_MODEL is not None:
            llm_tokenizer = AutoTokenizer.from_pretrained(KEYWORD_PARSER_MODEL)
            llm_model = AutoModelForCausalLM.from_pretrained(
                KEYWORD_PARSER_MODEL,
                torch_dtype=(
                    torch.bfloat16 if torch.cuda.is_available() else torch.float32
                ),
                device_map="auto",
            )
    except Exception as e:
        print(f"Error loading CLIP model: {e}")
        raise e


def extract_subjects_actions(tokenizer, model, query: str) -> str:

    system = (
        "You are a helpful assistant that specializes in natural language. "
        "Try to extract and list out all the subject, its features and some actions inside of the query. "
        "Only return the compact list like in the example; do not add any special character; NO EXPLANATION"
        "Example 1:\n"
        "- Input: On a white round plate is a glass of panna cotta. A hand places two more glasses of panna cotta on the plate. Each panna cotta has a smooth ivory cream layer, decorated with a few slices of red grapes and green mint leaves for a fresh highlight. Next to the plate are two edible flowers (red and yellow) to add to the beauty."
        "- Output: white round plate, panna cotta glass, there is hand, panna cotta glasses, placing on plate, panna cotta, ivory white smooth cream, topped with red grape slices and green mint leaves plate, edible flowers (red and yellow), enhance portion"
        "Example 2:\n"
        "- Input: Find a cycling video, shot from an aerial drone, showing a cyclist in a blue and white jersey passing three other cyclists and taking the lead. Then, know that this cyclist leads the rest of the way to the finish line."
        "- Output: bicycle racing video, overhead drone angle, athlete, blue and white shirt, overtaking three athletes, athlete, blue and white shirt, taking lead, athlete, blue and white shirt, led to finish"
        "Example 3:\n"
        "- Input: Video footage narrating a bicycle race. Find a scene with a head-on angle from above and follow the riders. In the frame, there are 3 riders pedaling in a straight line. All 3 riders are from the same team, with white uniforms and blue yellow pants. The first rider wears a white hat, the second rider wears a red hat, and the last rider wears a black hat."
        "- Output: video footage, bicycle race, narrating scene, head-on angle from above, follow riders, 3 riders, pedaling, in straight line, 3 riders, same team, white uniforms, blue yellow pants, first rider, white hat, second rider, red hat, last rider, black hat"
    )

    prompt = f"{system}\nInput: {query}\nOutput:"

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    input_length = inputs.input_ids.shape[1]

    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    with torch.inference_mode():
        outputs = model.generate(
            **inputs,
            max_new_tokens=50,
            do_sample=False,
            return_dict_in_generate=True,
            output_scores=True,
        )

    text = tokenizer.decode(
        outputs.sequences[0, input_length:], skip_special_tokens=True
    )

    del inputs, outputs

    torch.cuda.empty_cache()
    torch.cuda.ipc_collect()

    return text.strip().splitlines()[0].strip()


def initialize_translator():
    """Initialize Google Translator"""
    global translator
    try:
        translator = Translator()
        print("Google Translator initialized successfully")
    except Exception as e:
        print(f"Error initializing translator: {e}")
        translator = None


def translate_text(text, target_lang="en", source_lang="auto"):
    """Translate text to target language"""
    global translator
    if translator is None:
        return text, False  # Return original text if translator not available

    try:
        # Detect if text is already in English (or target language)
        detection = translator.detect(text)
        if detection.lang == target_lang:
            return text, False

        # Translate text
        result = translator.translate(text, src=source_lang, dest=target_lang)
        print(
            f"Translated '{text}' from {detection.lang} to {target_lang}: '{result.text}'"
        )
        return result.text, True
    except Exception as e:
        print(f"Translation error: {e}")
        return text, False  # Return original text if translation fails


def build_faiss_index():
    global faiss_index, faiss_id_map

    # Check if index files exist
    if os.path.exists(FAISS_INDEX_FILE) and os.path.exists(FAISS_ID_MAP_FILE):
        try:
            faiss_index = faiss.read_index(FAISS_INDEX_FILE)
            with open(FAISS_ID_MAP_FILE, "r") as f:
                faiss_id_map = json.load(f)
            print(f"FAISS index loaded: {faiss_index.ntotal} vectors")
            return
        except Exception as e:
            print(f"Error loading existing FAISS index: {e}")

    # Build new index from database - Updated table name
    print("Building FAISS index from database...")
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT id, embedding FROM keyframe_embeddings ORDER BY id")
    rows = cursor.fetchall()

    if not rows:
        print("No embeddings found in database")
        conn.close()
        return

    embeddings = []
    ids = []

    for row in rows:
        db_id = row["id"]
        embedding = row["embedding"]
        if embedding is not None and len(embedding) > 0:
            # Reshape embedding if needed
            if len(embedding.shape) == 1:
                embedding = embedding.reshape(1, -1)
            embeddings.append(embedding.flatten())
            ids.append(db_id)

    if not embeddings:
        print("No valid embeddings found")
        conn.close()
        return

    embeddings_np = np.array(embeddings).astype("float32")
    print(
        f"Building index with {len(embeddings)} vectors of dimension {embeddings_np.shape[1]}"
    )

    # Normalize embeddings for cosine similarity
    faiss.normalize_L2(embeddings_np)

    # Create FAISS index
    index = faiss.IndexFlatIP(
        embeddings_np.shape[1]
    )  # Inner product for cosine similarity
    index.add(embeddings_np)

    # Save index and ID mapping
    faiss.write_index(index, FAISS_INDEX_FILE)
    with open(FAISS_ID_MAP_FILE, "w") as f:
        json.dump(ids, f)

    faiss_index = index
    faiss_id_map = ids

    print(f"FAISS index built and saved: {faiss_index.ntotal} vectors")
    conn.close()


def encode_image(image):
    """Encode image using CLIP model"""
    if clip_model is None or clip_processor is None:
        raise HTTPException(status_code=500, detail="CLIP model not loaded")

    try:
        inputs = clip_processor(images=image, return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}

        with torch.no_grad():
            image_features = clip_model.get_image_features(**inputs)
            image_features = image_features / image_features.norm(dim=-1, keepdim=True)

        return image_features.cpu().numpy().astype("float32")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error encoding image: {str(e)}")


def encode_text(text):
    """Encode text using CLIP model"""
    if clip_model is None or clip_processor is None:
        raise HTTPException(status_code=500, detail="CLIP model not loaded")

    try:
        inputs = clip_processor(text=[text], return_tensors="pt", padding=True)
        inputs = {k: v.to(device) for k, v in inputs.items()}

        with torch.no_grad():
            text_features = clip_model.get_text_features(**inputs)
            text_features = text_features / text_features.norm(dim=-1, keepdim=True)

        return text_features.cpu().numpy().astype("float32")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error encoding text: {str(e)}")


def get_video_embeddings(video_id):
    """Get embeddings for a specific video (with caching) - Updated table name"""
    global video_embeddings_cache

    if video_id in video_embeddings_cache:
        return video_embeddings_cache[video_id]

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, embedding FROM keyframe_embeddings WHERE video_id = ? ORDER BY keyframe_n",
        (video_id,),
    )
    rows = cursor.fetchall()
    conn.close()

    embeddings = []
    ids = []
    for row in rows:
        if row["embedding"] is not None and len(row["embedding"]) > 0:
            embeddings.append(row["embedding"].flatten())
            ids.append(row["id"])

    if embeddings:
        embeddings_np = np.array(embeddings).astype("float32")
        faiss.normalize_L2(embeddings_np)
        video_embeddings_cache[video_id] = (embeddings_np, ids)
        return embeddings_np, ids

    return None, None


def search_videos_embeddings(query_embedding, video_ids, top_k=10):
    """Search within specific videos' embeddings - Updated table name"""
    if not video_ids:
        return []

    # Ensure embedding is 2D float32
    query_embedding = np.array(query_embedding).astype("float32")
    if query_embedding.ndim == 1:
        query_embedding = np.expand_dims(query_embedding, axis=0)
    faiss.normalize_L2(query_embedding)

    all_embeddings = []
    all_ids = []

    for video_id in video_ids:
        video_embeddings, video_db_ids = get_video_embeddings(video_id)
        if video_embeddings is not None and len(video_embeddings) > 0:
            video_embeddings = np.array(video_embeddings).astype("float32")
            all_embeddings.append(video_embeddings)
            all_ids.extend(video_db_ids)
        else:
            print(f"No embeddings found for video {video_id}")

    if not all_embeddings:
        return []

    # Stack all embeddings into one array
    embeddings_np = np.vstack(all_embeddings)
    faiss.normalize_L2(embeddings_np)

    # Build temporary FAISS index
    temp_index = faiss.IndexFlatIP(embeddings_np.shape[1])
    temp_index.add(embeddings_np)

    # Perform search
    scores, indices = temp_index.search(query_embedding, min(top_k, temp_index.ntotal))

    # Get corresponding DB IDs
    matched_ids = [all_ids[i] for i in indices[0] if i != -1]
    if not matched_ids:
        return []

    # Query database - Updated table name
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    placeholders = ",".join(["?" for _ in matched_ids])
    sql = f"SELECT * FROM keyframe_embeddings WHERE id IN ({placeholders})"
    cursor.execute(sql, matched_ids)
    rows = cursor.fetchall()
    conn.close()

    # Map ID to row
    id_to_row = {row["id"]: row for row in rows}

    # Combine result with similarity
    results = []
    for rank, idx in enumerate(indices[0]):
        if idx == -1:
            continue
        db_id = all_ids[idx]
        row = id_to_row.get(db_id)
        if row:
            result = {
                "id": row["id"],
                "video_id": row["video_id"],
                "keyframe_n": row["keyframe_n"],
                "image_filename": row["image_filename"],
                "image_path": row["image_path"],
                "pts_time": row["pts_time"],
                "fps": row["fps"],
                "frame_idx": row["frame_idx"],
                "video_title": row["video_title"],
                "video_author": row["video_author"],
                "video_description": row["video_description"],
                "video_length": row["video_length"],
                "publish_date": row["publish_date"],
                "watch_url": row["watch_url"],
                "thumbnail_url": row["thumbnail_url"],
                "similarity": float(scores[0][rank]),
            }
            results.append(result)

    results.sort(key=lambda x: x["similarity"], reverse=True)
    return results[:top_k]


def search_with_embedding(query_embedding, top_k=10, video_id=None):
    """Search using embedding vector in FAISS and return metadata from database - Updated table name"""
    if faiss_index is None or faiss_id_map is None:
        raise HTTPException(status_code=500, detail="FAISS index not available")

    if video_id:
        # Parse comma-separated video IDs
        video_ids = [vid.strip() for vid in video_id.split(",") if vid.strip()]
        return search_videos_embeddings(query_embedding, video_ids, top_k)

    # Ensure embedding is a 2D float32 numpy array
    query_embedding = np.array(query_embedding).astype("float32")
    if query_embedding.ndim == 1:
        query_embedding = np.expand_dims(query_embedding, axis=0)

    # Normalize the embedding
    faiss.normalize_L2(query_embedding)

    # Perform search in FAISS index
    search_k = min(top_k * 2, faiss_index.ntotal)
    if search_k == 0:
        return []  # nothing in index
    scores, indices = faiss_index.search(query_embedding, search_k)

    # Extract valid FAISS result indices and map to DB IDs
    db_ids = []
    index_id_map = {}
    for rank, faiss_idx in enumerate(indices[0]):
        if faiss_idx != -1 and faiss_idx < len(faiss_id_map):
            db_id = faiss_id_map[faiss_idx]
            db_ids.append(db_id)
            index_id_map[db_id] = rank  # to keep similarity mapping later

    if not db_ids:
        return []

    # Connect to the database
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row  # to get dict-like rows
    cursor = conn.cursor()

    # SQL query to get metadata - Updated table name
    placeholders = ",".join(["?" for _ in db_ids])
    sql = f"SELECT * FROM keyframe_embeddings WHERE id IN ({placeholders})"
    params = db_ids

    if video_id is not None:
        sql += " AND video_id = ?"
        params = db_ids + [video_id]

    cursor.execute(sql, params)
    rows = cursor.fetchall()
    conn.close()

    # Map results and attach similarity score
    id_to_row = {row["id"]: row for row in rows}
    results = []
    for db_id in db_ids:
        row = id_to_row.get(db_id)
        if row:
            rank = index_id_map[db_id]
            result = {
                "id": row["id"],
                "video_id": row["video_id"],
                "keyframe_n": row["keyframe_n"],
                "image_filename": row["image_filename"],
                "image_path": row["image_path"],
                "pts_time": row["pts_time"],
                "fps": row["fps"],
                "frame_idx": row["frame_idx"],
                "video_title": row["video_title"],
                "video_author": row["video_author"],
                "video_description": row["video_description"],
                "video_length": row["video_length"],
                "publish_date": row["publish_date"],
                "watch_url": row["watch_url"],
                "thumbnail_url": row["thumbnail_url"],
                "similarity": float(scores[0][rank]),
            }
            results.append(result)

    # Sort by similarity and return top_k
    results.sort(key=lambda x: x["similarity"], reverse=True)
    return results[:top_k]


# API Routes
@app.on_event("startup")
async def startup_event():
    """Initialize models and indexes on startup"""
    print("Starting up Image Retrieval System...")

    try:
        print("Loading CLIP model...")
        load_models()
        print("✅ CLIP model loaded successfully")

        print("Initializing translator...")
        initialize_translator()
        print("✅ Translator initialized successfully")

        print("Building/Loading FAISS index...")
        build_faiss_index()
        print("✅ FAISS index ready")

        print("🚀 Startup completed successfully!")

    except Exception as e:
        print(f"❌ Startup failed: {e}")
        print("Please check your setup and try again.")


@app.get("/")
async def root():
    """Serve main page"""
    return FileResponse("static/index.html")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "clip_model_loaded": clip_model is not None,
        "faiss_index_loaded": faiss_index is not None,
        "faiss_index_size": faiss_index.ntotal if faiss_index else 0,
        "translator_loaded": translator is not None,
    }


@app.get("/test/frame/{frame_id}")
async def test_frame(frame_id: int):
    """Simple test endpoint for frame data - Updated table name"""
    try:
        if not os.path.exists(DATABASE_FILE):
            return {"error": "Database not found"}

        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT id, video_id, keyframe_n, image_filename FROM keyframe_embeddings WHERE id = ?",
            (frame_id,),
        )
        row = cursor.fetchone()
        conn.close()

        if not row:
            return {"error": "Frame not found"}

        return {"success": True, "frame": dict(row)}
    except Exception as e:
        return {"error": str(e)}


@app.get("/debug/db")
async def debug_database():
    """Debug database structure and sample data - Updated table name"""
    if not os.path.exists(DATABASE_FILE):
        return {"error": "Database file not found"}

    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        # Get table info
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()

        # Get sample frame data
        cursor.execute(
            "SELECT id, video_id, keyframe_n, image_filename FROM keyframe_embeddings LIMIT 5"
        )
        sample_frames = cursor.fetchall()

        # Get total count
        cursor.execute("SELECT COUNT(*) FROM keyframe_embeddings")
        total_count = cursor.fetchone()[0]

        conn.close()

        return {
            "database_exists": True,
            "tables": [dict(t) for t in tables],
            "total_frames": total_count,
            "sample_frames": [dict(f) for f in sample_frames],
        }
    except Exception as e:
        return {"error": f"Database error: {str(e)}"}


@app.post("/search/text")
async def search_by_text(
    query: str = Query(..., description="Text query"),
    top_k: int = Query(10, description="Number of results to return"),
    video_id: Optional[str] = Query(
        None,
        description="Search within specific video(s). Use comma-separated values for multiple videos: 'video1,video2,video3'",
    ),
    translate: bool = Query(
        True, description="Auto-translate non-English queries to English"
    ),
    target_lang: str = Query("en", description="Target language for translation"),
):
    """Search images by text query with optional translation"""
    if not query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    original_query = query
    translated = False

    # Translate query if requested
    if translate:
        query, translated = translate_text(query, target_lang)

    if KEYWORD_PARSER_MODEL is not None:
        query = extract_subjects_actions(llm_tokenizer, llm_model, query)
        print(f"Extracted query: {query}")

    try:
        # Encode text query
        text_embedding = encode_text(query)

        # Search
        results = search_with_embedding(text_embedding, top_k, video_id)

        return {
            "original_query": original_query,
            "query": query,
            "translated": translated,
            "results": results,
            "total_found": len(results),
        }
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Error in text search: {e}")
        raise HTTPException(status_code=500, detail=f"Search error: {str(e)}")


@app.post("/translate")
async def translate_query(
    text: str = Query(..., description="Text to translate"),
    target_lang: str = Query(
        "en", description="Target language code (e.g., 'en', 'vi', 'es')"
    ),
    source_lang: str = Query(
        "auto", description="Source language code or 'auto' for detection"
    ),
):
    """Translate text to target language"""
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    try:
        translated_text, was_translated = translate_text(text, target_lang, source_lang)

        return {
            "original_text": text,
            "translated_text": translated_text,
            "was_translated": was_translated,
            "target_language": target_lang,
            "source_language": source_lang,
        }
    except Exception as e:
        print(f"Error in translation: {e}")
        raise HTTPException(status_code=500, detail=f"Translation error: {str(e)}")


@app.post("/search/image")
async def search_by_image(
    file: UploadFile = File(...),
    top_k: int = Query(10, description="Number of results to return"),
    video_id: Optional[str] = Query(
        None,
        description="Search within specific video(s). Use comma-separated values for multiple videos: 'video1,video2,video3'",
    ),
):
    """Search images by uploaded image"""
    if not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    try:
        # Read and process image
        image_data = await file.read()
        image = Image.open(io.BytesIO(image_data)).convert("RGB")

        # Encode image
        image_embedding = encode_image(image)

        # Search
        results = search_with_embedding(image_embedding, top_k, video_id)

        return {
            "filename": file.filename,
            "results": results,
            "total_found": len(results),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/frame/{frame_id}")
async def get_frame_metadata(frame_id: int):
    """Get metadata for a specific frame - Updated table name"""
    try:
        if not os.path.exists(DATABASE_FILE):
            raise HTTPException(status_code=500, detail="Database not found")

        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM keyframe_embeddings WHERE id = ?", (frame_id,))
        row = cursor.fetchone()
        conn.close()

        if not row:
            raise HTTPException(status_code=404, detail="Frame not found")

        # Convert to dict and exclude embedding data
        frame_dict = {}
        for key in row.keys():
            if key != "embedding":  # Skip embedding data
                frame_dict[key] = row[key]

        print(f"Returning frame metadata for frame_id: {frame_id}")
        return frame_dict

    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Error in get_frame_metadata: {e}")
        raise HTTPException(
            status_code=500, detail=f"Error getting frame metadata: {str(e)}"
        )


@app.get("/frames/surrounding/{frame_id}")
async def get_surrounding_frames(
    frame_id: int,
    window_size: int = Query(5, description="Number of frames before and after"),
):
    """Get surrounding frames for a specific frame - Updated table name"""
    try:
        if not os.path.exists(DATABASE_FILE):
            raise HTTPException(
                status_code=500,
                detail="Database not found. Please run migration script first.",
            )

        conn = get_db_connection()
        cursor = conn.cursor()

        print(f"Getting surrounding frames for frame_id: {frame_id}")

        # Get the target frame
        print(f"Querying database for frame_id: {frame_id}")
        cursor.execute("SELECT * FROM keyframe_embeddings WHERE id = ?", (frame_id,))
        target_frame = cursor.fetchone()
        print(f"Target frame result: {target_frame is not None}")

        if not target_frame:
            conn.close()
            raise HTTPException(
                status_code=404, detail=f"Frame with ID {frame_id} not found"
            )

        video_id = target_frame["video_id"]
        target_keyframe_n = target_frame["keyframe_n"]

        print(f"Target frame: video_id={video_id}, keyframe_n={target_keyframe_n}")

        # Get surrounding frames from the same video
        start_keyframe = max(1, target_keyframe_n - window_size)
        end_keyframe = target_keyframe_n + window_size

        cursor.execute(
            """
            SELECT keyframe_n, image_filename, image_path, pts_time 
            FROM keyframe_embeddings 
            WHERE video_id = ? AND keyframe_n BETWEEN ? AND ?
            ORDER BY keyframe_n
        """,
            (video_id, start_keyframe, end_keyframe),
        )

        rows = cursor.fetchall()
        conn.close()

        surrounding_frames = []
        for row in rows:
            frame_dict = {
                "keyframe_n": row["keyframe_n"],
                "image_filename": row["image_filename"],
                "image_path": row["image_path"],
                "pts_time": row["pts_time"],
                "is_current": (row["keyframe_n"] == target_keyframe_n),
            }
            surrounding_frames.append(frame_dict)

        # Convert target_frame to dict properly
        target_frame_dict = {}
        for key in target_frame.keys():
            value = target_frame[key]
            # Skip embedding data for response
            if key != "embedding":
                target_frame_dict[key] = value

        result = {
            "target_frame": target_frame_dict,
            "surrounding_frames": surrounding_frames,
        }

        print(f"Returning {len(surrounding_frames)} surrounding frames")
        return result

    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Error in get_surrounding_frames: {e}")
        import traceback

        traceback.print_exc()
        raise HTTPException(
            status_code=500, detail=f"Error getting surrounding frames: {str(e)}"
        )


@app.get("/video/{video_id}/frames")
async def get_video_frames(video_id: str):
    """Get all frames for a specific video - Updated table name"""
    try:
        if not os.path.exists(DATABASE_FILE):
            raise HTTPException(status_code=500, detail="Database not found")

        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, video_id, keyframe_n, image_filename, image_path, pts_time, 
                   fps, frame_idx, video_title, video_author, video_description, 
                   video_length, publish_date, watch_url, thumbnail_url
            FROM keyframe_embeddings 
            WHERE video_id = ? 
            ORDER BY keyframe_n
        """,
            (video_id,),
        )

        rows = cursor.fetchall()
        conn.close()

        if not rows:
            raise HTTPException(status_code=404, detail="Video not found")

        return [dict(row) for row in rows]

    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Error in get_video_frames: {e}")
        raise HTTPException(
            status_code=500, detail=f"Error getting video frames: {str(e)}"
        )


@app.get("/stats")
async def get_statistics():
    """Get database statistics - Updated table name"""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) as total_frames FROM keyframe_embeddings")
    total_frames = cursor.fetchone()["total_frames"]

    cursor.execute(
        "SELECT COUNT(DISTINCT video_id) as total_videos FROM keyframe_embeddings"
    )
    total_videos = cursor.fetchone()["total_videos"]

    cursor.execute(
        "SELECT video_id, COUNT(*) as frame_count FROM keyframe_embeddings GROUP BY video_id LIMIT 10"
    )
    top_videos = cursor.fetchall()

    conn.close()

    return {
        "total_frames": total_frames,
        "total_videos": total_videos,
        "faiss_index_size": faiss_index.ntotal if faiss_index else 0,
        "top_videos": [dict(row) for row in top_videos],
    }


@app.post("/similarity/frame-text")
async def calculate_frame_text_similarity(
    frame_id: int = Query(..., description="Frame ID to calculate similarity for"),
    text_query: str = Query(..., description="Text query to compare against"),
):
    """Calculate similarity between a specific frame and text query"""
    if not text_query.strip():
        raise HTTPException(status_code=400, detail="Text query cannot be empty")
    
    try:
        # Get frame embedding from database
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT embedding FROM keyframe_embeddings WHERE id = ?", (frame_id,)
        )
        row = cursor.fetchone()
        conn.close()
        
        if not row or row["embedding"] is None:
            raise HTTPException(status_code=404, detail="Frame not found or no embedding available")
        
        frame_embedding = row["embedding"]
        
        # Ensure frame embedding is normalized
        frame_embedding = frame_embedding / np.linalg.norm(frame_embedding)
        
        # Get text embedding
        text_embedding = encode_text(text_query)
        text_embedding = text_embedding.flatten()
        
        # Calculate cosine similarity
        similarity = float(np.dot(frame_embedding, text_embedding))
        
        # Clamp to [0, 1] range
        similarity = max(0.0, min(1.0, similarity))
        
        return {
            "frame_id": frame_id,
            "text_query": text_query,
            "similarity": similarity
        }
        
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Error calculating frame-text similarity: {e}")
        raise HTTPException(status_code=500, detail=f"Similarity calculation error: {str(e)}")


@app.post("/similarity/batch-matrix")
async def calculate_batch_similarity_matrix(request: dict):
    """Calculate similarity matrix for multiple frames and text queries in one batch operation"""
    # Extract data from request body
    frame_ids = request.get("frame_ids", [])
    text_queries = request.get("text_queries", [])
    
    if not frame_ids:
        raise HTTPException(status_code=400, detail="Frame IDs list cannot be empty")
    if not text_queries:
        raise HTTPException(status_code=400, detail="Text queries list cannot be empty")
    
    # Limit batch size to prevent memory issues
    max_frames = 200
    max_queries = 10
    
    if len(frame_ids) > max_frames:
        raise HTTPException(status_code=400, detail=f"Too many frames. Maximum: {max_frames}")
    if len(text_queries) > max_queries:
        raise HTTPException(status_code=400, detail=f"Too many queries. Maximum: {max_queries}")
    
    try:
        print(f"🚀 Batch similarity computation: {len(text_queries)} queries × {len(frame_ids)} frames")
        start_time = time.time()
        
        # Get all frame embeddings in one database query
        conn = get_db_connection()
        cursor = conn.cursor()
        placeholders = ",".join(["?" for _ in frame_ids])
        cursor.execute(
            f"SELECT id, embedding FROM keyframe_embeddings WHERE id IN ({placeholders}) ORDER BY id",
            frame_ids
        )
        rows = cursor.fetchall()
        conn.close()
        
        if len(rows) != len(frame_ids):
            missing_ids = set(frame_ids) - {row["id"] for row in rows}
            raise HTTPException(status_code=404, detail=f"Frames not found: {list(missing_ids)}")
        
        # Create ID to index mapping to preserve order
        id_to_row = {row["id"]: row for row in rows}
        
        # Build frame embeddings matrix [num_frames, embedding_dim] - preserve order
        frame_embeddings = []
        for frame_id in frame_ids:
            embedding = id_to_row[frame_id]["embedding"]
            if embedding is None:
                raise HTTPException(status_code=404, detail=f"No embedding for frame {frame_id}")
            # Normalize
            embedding = embedding / np.linalg.norm(embedding)
            frame_embeddings.append(embedding)
        
        frame_embeddings_matrix = np.array(frame_embeddings).astype("float32")  # [num_frames, dim]
        
        # Build text embeddings matrix [num_queries, embedding_dim]
        text_embeddings = []
        for query in text_queries:
            if not query.strip():
                raise HTTPException(status_code=400, detail="Text query cannot be empty")
            text_embedding = encode_text(query.strip())
            text_embeddings.append(text_embedding.flatten())
        
        text_embeddings_matrix = np.array(text_embeddings).astype("float32")  # [num_queries, dim]
        
        # Vectorized similarity computation: [num_queries, num_frames]
        # similarity_matrix[i, j] = similarity between query i and frame j
        similarity_matrix = np.dot(text_embeddings_matrix, frame_embeddings_matrix.T)
        
        # Clamp to [0, 1] range
        similarity_matrix = np.clip(similarity_matrix, 0.0, 1.0)
        
        end_time = time.time()
        computation_time = (end_time - start_time) * 1000  # Convert to milliseconds
        
        print(f"✅ Vectorized computation completed in {computation_time:.2f}ms")
        
        return {
            "frame_ids": frame_ids,
            "text_queries": text_queries,
            "similarity_matrix": similarity_matrix.tolist(),  # [num_queries, num_frames]
            "shape": [len(text_queries), len(frame_ids)],
            "computation_time_ms": computation_time
        }
        
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Error calculating batch similarity matrix: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Batch similarity error: {str(e)}")


# Serve static files (images) - Keep original path structure
app.mount("/images", StaticFiles(directory="D:/keyframes"), name="images")
app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
