from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import sqlite3
import numpy as np
import json
import os
import io
from PIL import Image
import torch
from transformers import CLIPProcessor, CLIPModel, AutoProcessor
import faiss
from typing import List, Optional

# from pydantic import BaseModel  # Not needed since we use plain dicts
import uvicorn

# Configuration
DATABASE_FILE = "D:/keyframe_embeddings_clip.db"
FAISS_INDEX_FILE = "D:/keyframe_faiss_clip.index"
FAISS_ID_MAP_FILE = "D:/keyframe_faiss_map_clip.json"
EMBEDDING_DIM = 1280  # Adjust based on your embeddings
SIGLIP_MODEL_NAME = "laion/CLIP-ViT-bigG-14-laion2B-39B-b160k"

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
siglip_model = None
siglip_processor = None
faiss_index = None
faiss_id_map = None
device = "cuda" if torch.cuda.is_available() else "cpu"

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
def load_siglip_model():
    global siglip_model, siglip_processor
    try:
        print(f"Loading SigLIP model: {SIGLIP_MODEL_NAME}")
        siglip_processor = AutoProcessor.from_pretrained(SIGLIP_MODEL_NAME)
        siglip_model = CLIPModel.from_pretrained(SIGLIP_MODEL_NAME)
        siglip_model = siglip_model.to(device)
        siglip_model.eval()
        print(f"SigLIP model loaded successfully on {device}")
    except Exception as e:
        print(f"Error loading SigLIP model: {e}")
        raise e


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

    # Build new index from database
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
    """Encode image using SigLIP model"""
    if siglip_model is None or siglip_processor is None:
        raise HTTPException(status_code=500, detail="SigLIP model not loaded")

    try:
        inputs = siglip_processor(images=image, return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}

        with torch.no_grad():
            image_features = siglip_model.get_image_features(**inputs)
            image_features = image_features / image_features.norm(dim=-1, keepdim=True)

        return image_features.cpu().numpy().astype("float32")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error encoding image: {str(e)}")


def encode_text(text):
    """Encode text using SigLIP model"""
    if siglip_model is None or siglip_processor is None:
        raise HTTPException(status_code=500, detail="SigLIP model not loaded")

    try:
        inputs = siglip_processor(text=[text], return_tensors="pt", padding=True)
        inputs = {k: v.to(device) for k, v in inputs.items()}

        with torch.no_grad():
            text_features = siglip_model.get_text_features(**inputs)
            text_features = text_features / text_features.norm(dim=-1, keepdim=True)

        return text_features.cpu().numpy().astype("float32")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error encoding text: {str(e)}")


def search_with_embedding(query_embedding, top_k=10, video_id=None):
    """Search using embedding vector and return ranked metadata with correct scores."""
    if faiss_index is None or faiss_id_map is None:
        raise HTTPException(status_code=500, detail="FAISS index not available")

    # Prepare query: float32, 2D, contiguous
    q = np.asarray(query_embedding, dtype="float32")
    if q.ndim == 1:
        q = q[None, :]
    q = np.ascontiguousarray(q)

    # Optional: normalize ONLY if you built the index for cosine/IP with normalized db vectors.
    try:
        # If you want cosine similarity via inner product, keep this.
        faiss.normalize_L2(q)
    except Exception:
        pass

    # Run search
    try:
        D, I = faiss_index.search(q, top_k)
    except Exception as e:
        print(f"LOI :V : {e}")
        return []

    # Map FAISS indices -> DB ids, keep rank
    faiss_hits = []
    for rank, (idx, dist) in enumerate(zip(I[0], D[0])):
        if idx == -1:
            continue
        db_id = faiss_id_map[idx]
        faiss_hits.append((db_id, float(dist)))

    if not faiss_hits:
        return []

    # Optionally filter by video_id after DB fetch (or in SQL)
    db_ids = [hid for (hid, _) in faiss_hits]

    # Fetch rows
    conn = get_db_connection()
    cursor = conn.cursor()

    placeholders = ",".join(["?"] * len(db_ids))
    base_query = f"SELECT * FROM keyframe_embeddings WHERE id IN ({placeholders})"
    params = db_ids

    if video_id is not None:
        base_query += " AND video_id = ?"
        params = db_ids + [video_id]

    cursor.execute(base_query, params)
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        return []

    # Build a lookup from id -> row
    row_by_id = {row["id"]: row for row in rows}

    # Metric-aware sorting: figure out if higher-is-better
    # Default to IP being higher-better, L2 lower-better.
    higher_is_better = True
    try:
        metric = getattr(faiss_index, "metric_type", None)
        if metric == faiss.METRIC_L2:
            higher_is_better = False
    except Exception:
        pass

    # Compose results in the original FAISS rank order, skipping filtered-out ids
    results = []
    for db_id, dist in faiss_hits:
        row = row_by_id.get(db_id)
        if row is None:
            continue
        results.append(
            {
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
                # Store as 'score' where higher is always better for the caller:
                # If metric is L2, convert to negative distance so "higher is better".
                "similarity": (-dist if not higher_is_better else dist),
            }
        )

    # Already in FAISS rank order; but if you've mixed in filtered items, sort by our unified score.
    results.sort(key=lambda x: x["similarity"], reverse=True)

    return results[:top_k]


# API Routes
@app.on_event("startup")
async def startup_event():
    """Initialize models and indexes on startup"""
    print("Starting up Image Retrieval System...")

    try:
        print("Loading SigLIP model...")
        load_siglip_model()
        print("✅ SigLIP model loaded successfully")

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
        "siglip_model_loaded": siglip_model is not None,
        "faiss_index_loaded": faiss_index is not None,
        "faiss_index_size": faiss_index.ntotal if faiss_index else 0,
    }


@app.get("/test/frame/{frame_id}")
async def test_frame(frame_id: int):
    """Simple test endpoint for frame data"""
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
    """Debug database structure and sample data"""
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
    video_id: Optional[str] = Query(None, description="Search within specific video"),
):
    """Search images by text query"""
    if not query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    try:
        # Encode text query
        text_embedding = encode_text(query)

        # Search
        results = search_with_embedding(text_embedding, top_k, video_id)

        return {"query": query, "results": results, "total_found": len(results)}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Error in text search: {e}")
        raise HTTPException(status_code=500, detail=f"Search error: {str(e)}")


@app.post("/search/image")
async def search_by_image(
    file: UploadFile = File(...),
    top_k: int = Query(10, description="Number of results to return"),
    video_id: Optional[str] = Query(None, description="Search within specific video"),
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
    """Get metadata for a specific frame"""
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
    """Get surrounding frames for a specific frame"""
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
    """Get all frames for a specific video"""
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
    """Get database statistics"""
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


# Serve static files (images)
app.mount("/images", StaticFiles(directory="D:/keyframes"), name="images")
app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8002)
