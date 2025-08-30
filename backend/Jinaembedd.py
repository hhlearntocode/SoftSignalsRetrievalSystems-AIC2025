import torch
import torch.nn as nn
import os
import numpy as np
from PIL import Image
import pandas as pd
from tqdm import tqdm
import json
from pathlib import Path
import sqlite3
import faiss # Import FAISS

# Jina Embeddings v4 backend
try:
    from transformers import AutoModel
    _HAS_JINA = True
except Exception:
    _HAS_JINA = False

# --- Constants ---
EMBEDDING_DIM = 2048  # Jina v4 single vector dimension
JINA_MODEL_ID = "jinaai/jina-embeddings-v4"
DATABASE_FILE = "keyframe_embeddings_jina_v4.db"
FAISS_INDEX_FILE = "keyframe_faiss_jina_v4.index"
FAISS_ID_MAP_FILE = "keyframe_faiss_map_jina_v4.json"

# Data paths
KEYFRAMES_ROOT = "backend/keyframes"
MEDIA_INFO_ROOT = "backend/media-info"
MAP_KEYFRAMES_ROOT = "backend/map-keyframes"

# --- Database Utility Functions (SQLite) ---
def adapt_array(arr):
    return arr.tobytes()

def convert_array(text):
    return np.frombuffer(text, dtype=np.float32).reshape(-1, EMBEDDING_DIM)

sqlite3.register_adapter(np.ndarray, adapt_array)
sqlite3.register_converter("array", convert_array)

def setup_database(db_path=DATABASE_FILE):
    conn = sqlite3.connect(db_path, detect_types=sqlite3.PARSE_DECLTYPES)
    cursor = conn.cursor()
    
    # Create table with all columns (including new multivector columns)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS keyframe_embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id TEXT,
            keyframe_n INTEGER,
            image_filename TEXT,
            image_path TEXT UNIQUE,
            pts_time REAL,
            fps REAL,
            frame_idx INTEGER,
            embedding array,
            video_title TEXT,
            video_author TEXT,
            video_description TEXT,
            video_length INTEGER,
            publish_date TEXT,
            watch_url TEXT,
            thumbnail_url TEXT
        )
    ''')
    
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_video_id ON keyframe_embeddings (video_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_image_path ON keyframe_embeddings (image_path)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_keyframe_n ON keyframe_embeddings (keyframe_n)')
    conn.commit()
    
    return conn

def insert_keyframe_data_to_db(conn, keyframe_data):
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO keyframe_embeddings 
            (video_id, keyframe_n, image_filename, image_path, pts_time, fps, frame_idx, embedding,
             video_title, video_author, video_description, video_length, publish_date, watch_url, thumbnail_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            keyframe_data['video_id'],
            keyframe_data['keyframe_n'],
            keyframe_data['image_filename'],
            keyframe_data['image_path'],
            keyframe_data['pts_time'],
            keyframe_data['fps'],
            keyframe_data['frame_idx'],
            keyframe_data['embedding'].astype(np.float32).reshape(1, -1),
            keyframe_data['video_title'],
            keyframe_data['video_author'],
            keyframe_data['video_description'],
            keyframe_data['video_length'],
            keyframe_data['publish_date'],
            keyframe_data['watch_url'],
            keyframe_data['thumbnail_url']
        ))
        conn.commit()
        return cursor.lastrowid
    except sqlite3.IntegrityError:
        cursor.execute("SELECT id FROM keyframe_embeddings WHERE image_path = ?", (keyframe_data['image_path'],))
        row = cursor.fetchone()
        return row[0] if row else None
    except Exception as e:
        print(f"Error inserting keyframe data for {keyframe_data['image_path']}: {e}")
        return None

def get_all_embeddings_and_db_ids(conn):
    """Fetches all embeddings and their corresponding database IDs."""
    cursor = conn.cursor()
    cursor.execute("SELECT id, embedding FROM keyframe_embeddings")
    data = []
    for row in cursor.fetchall():
        db_id = row[0]
        embedding_array = row[1] # Already converted by SQLite type converter
        if embedding_array is not None and embedding_array.shape == (1, EMBEDDING_DIM):
            data.append({'db_id': db_id, 'embedding': embedding_array.squeeze()})
        elif embedding_array is not None : # Handle potential old format if any
             data.append({'db_id': db_id, 'embedding': embedding_array}) # assume it's already 1D
    
    if not data:
        return [], np.array([], dtype=np.float32)

    db_ids = [item['db_id'] for item in data]
    embeddings = np.array([item['embedding'] for item in data]).astype(np.float32)
    return db_ids, embeddings


def get_metadata_for_db_ids(conn, db_ids_list):
    """Retrieves metadata for a list of database IDs."""
    if not db_ids_list:
        return {}
    cursor = conn.cursor()
    # Create a string of placeholders for the query: (?, ?, ?, ...)
    placeholders = ', '.join(['?'] * len(db_ids_list))
    query = f"""SELECT id, video_id, keyframe_n, image_filename, image_path, pts_time, fps, frame_idx,
                       video_title, video_author, video_description, video_length, publish_date, watch_url, thumbnail_url
                FROM keyframe_embeddings WHERE id IN ({placeholders})"""
    cursor.execute(query, db_ids_list)
    
    results_map = {}
    for row in cursor.fetchall():
        results_map[row[0]] = { # Keyed by db_id
            "db_id": row[0],
            "video_id": row[1],
            "keyframe_n": row[2],
            "image_filename": row[3],
            "image_path": row[4],
            "pts_time": row[5],
            "fps": row[6],
            "frame_idx": row[7],
            "video_title": row[8],
            "video_author": row[9],
            "video_description": row[10],
            "video_length": row[11],
            "publish_date": row[12],
            "watch_url": row[13],
            "thumbnail_url": row[14],
        }
    return results_map


def check_if_keyframe_exists_in_db(conn, image_path_to_check):
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(id) FROM keyframe_embeddings WHERE image_path = ?", (image_path_to_check,))
    count = cursor.fetchone()[0]
    return count > 0

# --- FAISS Utility Functions ---
def build_and_save_faiss_index(db_conn, index_path=FAISS_INDEX_FILE, map_path=FAISS_ID_MAP_FILE):
    print("Building FAISS index from database...")
    db_ids, embeddings_np = get_all_embeddings_and_db_ids(db_conn)

    if embeddings_np.size == 0:
        print("No embeddings found in the database to build FAISS index.")
        # Create empty files or handle as an error
        if Path(index_path).exists(): os.remove(index_path)
        if Path(map_path).exists(): os.remove(map_path)
        return None, []

    # Normalize embeddings for IndexFlatIP (cosine similarity)
    faiss.normalize_L2(embeddings_np)

    index = faiss.IndexFlatIP(EMBEDDING_DIM)
    index.add(embeddings_np)
    
    print(f"FAISS index built with {index.ntotal} vectors.")
    faiss.write_index(index, index_path)
    print(f"FAISS index saved to {index_path}")

    # Save the mapping from FAISS's sequential IDs (0 to ntotal-1) to our db_ids
    # In this case, since we add all at once, FAISS ID 'i' corresponds to db_ids[i]
    faiss_to_db_id_map = db_ids # list where index is faiss_id, value is db_id
    with open(map_path, 'w') as f:
        json.dump(faiss_to_db_id_map, f)
    print(f"FAISS ID map saved to {map_path}")
    
    return index, faiss_to_db_id_map

def load_faiss_index_and_map(index_path=FAISS_INDEX_FILE, map_path=FAISS_ID_MAP_FILE):
    if not Path(index_path).exists() or not Path(map_path).exists():
        print("FAISS index or map file not found.")
        return None, None
    try:
        index = faiss.read_index(index_path)
        print(f"FAISS index loaded from {index_path} with {index.ntotal} vectors.")
        with open(map_path, 'r') as f:
            faiss_to_db_id_map = json.load(f)
        print(f"FAISS ID map loaded from {map_path}")
        return index, faiss_to_db_id_map
    except Exception as e:
        print(f"Error loading FAISS index or map: {e}")
        return None, None

# --- Helper Functions ---
def safe_tensor_to_numpy(tensor_obj):
    """Safely convert tensor/list (possibly on GPU) to numpy array"""
    # Handle lists (common with Jina v4 multivector output)
    if isinstance(tensor_obj, list):
        # Convert each item in the list
        converted_items = []
        for item in tensor_obj:
            if isinstance(item, torch.Tensor):
                converted_items.append(item.cpu().detach().numpy())
            elif hasattr(item, 'cpu') and hasattr(item, 'detach'):
                converted_items.append(item.cpu().detach().numpy())
            elif hasattr(item, 'cpu'):
                converted_items.append(item.cpu().numpy())
            else:
                converted_items.append(np.array(item))
        return np.array(converted_items)
    
    # Handle regular tensors
    elif isinstance(tensor_obj, torch.Tensor):
        return tensor_obj.cpu().detach().numpy()
    elif hasattr(tensor_obj, 'cpu') and hasattr(tensor_obj, 'detach'):
        # Handle tensor-like objects
        return tensor_obj.cpu().detach().numpy()
    elif hasattr(tensor_obj, 'cpu'):
        # Handle objects with cpu() method but no detach()
        try:
            return tensor_obj.cpu().numpy()
        except:
            return np.array(tensor_obj.cpu())
    else:
        # Last resort - try direct conversion
        try:
            return np.array(tensor_obj)
        except Exception as e:
            # If all else fails, at least try to get it to CPU if possible
            if hasattr(tensor_obj, 'cpu'):
                return np.array(tensor_obj.cpu())
            else:
                raise ValueError(f"Cannot convert {type(tensor_obj)} to numpy array: {e}")

# --- Jina v4 Embedding and Search Functions ---
def process_keyframe_batch_jina(conn, batch_images, batch_keyframe_data, model, device):
    if not batch_images:
        return 0
    try:
        # Convert PIL images to paths for Jina model
        image_paths = []
        for img in batch_images:
            # Save PIL image to temporary path if needed, or use existing paths
            # For this implementation, we'll assume images are already saved
            temp_path = f"/tmp/temp_image_{len(image_paths)}.jpg"
            img.save(temp_path)
            image_paths.append(temp_path)
        
        with torch.no_grad():
            try:
                # Use Jina v4 default encoding
                image_embeddings = model.encode_image(
                    images=image_paths,
                    task="retrieval"
                )
                
                # Debug: Print what Jina v4 is returning
                print(f"📋 Jina v4 trả về kiểu: {type(image_embeddings)}")
                if isinstance(image_embeddings, list):
                    print(f"📋 Độ dài list: {len(image_embeddings)}")
                    if len(image_embeddings) > 0:
                        print(f"📋 Kiểu item đầu tiên: {type(image_embeddings[0])}")
                        if hasattr(image_embeddings[0], 'shape'):
                            print(f"📋 Shape item đầu tiên: {image_embeddings[0].shape}")
                elif hasattr(image_embeddings, 'shape'):
                    print(f"📋 Shape: {image_embeddings.shape}")
                
                # Convert to numpy safely - Jina v4 sẽ trả về đúng format
                embeddings_np = safe_tensor_to_numpy(image_embeddings)
                print(f"✅ Thành công chuyển đổi sang numpy: {embeddings_np.shape}")
                print(f"🎯 Jina v4 default embedding shape: {embeddings_np.shape}")
                    
            except Exception as e:
                print(f"[Batch] Error extracting Jina embeddings: {e}")
                # Clean up temp files
                for path in image_paths:
                    if os.path.exists(path):
                        os.remove(path)
                return 0
                
        count = 0
        for i, keyframe_data in enumerate(batch_keyframe_data):
            keyframe_data['embedding'] = embeddings_np[i]
            print(f"💾 Saving embedding {i}: shape {embeddings_np[i].shape}")
            db_id = insert_keyframe_data_to_db(conn, keyframe_data)
            if db_id is not None:
                count += 1
            
        print(f"✅ THÀNH CÔNG: Đã lưu {count}/{len(batch_keyframe_data)} embeddings trong batch!")
        
        # Clean up temp files
        for path in image_paths:
            if os.path.exists(path):
                os.remove(path)
                
        return count
    except Exception as e:
        print(f"[Batch] Error processing keyframe batch with Jina: {e}")
        return 0

def load_video_metadata(video_id):
    """Load metadata from media-info JSON file"""
    media_info_path = os.path.join(MEDIA_INFO_ROOT, f"{video_id}.json")
    if not os.path.exists(media_info_path):
        print(f"Warning: No metadata found for {video_id}")
        return {}
    
    try:
        with open(media_info_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading metadata for {video_id}: {e}")
        return {}

def load_keyframe_mapping(video_id):
    """Load keyframe mapping from CSV file"""
    csv_path = os.path.join(MAP_KEYFRAMES_ROOT, f"{video_id}.csv")
    if not os.path.exists(csv_path):
        print(f"Warning: No keyframe mapping found for {video_id}")
        return {}
    
    try:
        import pandas as pd
        df = pd.read_csv(csv_path)
        # Create mapping: n -> {pts_time, fps, frame_idx}
        mapping = {}
        for _, row in df.iterrows():
            mapping[int(row['n'])] = {
                'pts_time': float(row['pts_time']),
                'fps': float(row['fps']),
                'frame_idx': int(row['frame_idx'])
            }
        return mapping
    except Exception as e:
        print(f"Error loading keyframe mapping for {video_id}: {e}")
        return {}

def ingest_keyframes_to_db_jina(db_conn, model, device, force_reingest_all=False, batch_size=8):
    """Process all video keyframes from the keyframes directory structure using Jina v4"""
    if not os.path.exists(KEYFRAMES_ROOT):
        print(f"Error: Keyframes directory not found: {KEYFRAMES_ROOT}")
        return
    
    # Get all video directories
    video_dirs = [d for d in os.listdir(KEYFRAMES_ROOT) 
                  if os.path.isdir(os.path.join(KEYFRAMES_ROOT, d))]
    
    total_videos = len(video_dirs)
    total_keyframes_processed = 0
    newly_inserted_count = 0
    skipped_count = 0
    error_count = 0
    
    print(f"Found {total_videos} video directories")
    
    batch_images = []
    batch_keyframe_data = []
    
    for video_id in tqdm(video_dirs, desc="Processing videos"):
        # Load video metadata and keyframe mapping
        video_metadata = load_video_metadata(video_id)
        keyframe_mapping = load_keyframe_mapping(video_id)
        
        video_dir = os.path.join(KEYFRAMES_ROOT, video_id)
        keyframe_files = sorted([f for f in os.listdir(video_dir) if f.endswith('.jpg')])
        
        for keyframe_file in keyframe_files:
            try:
                # Extract keyframe number from filename (e.g., "001.jpg" -> 1)
                keyframe_n = int(keyframe_file.split('.')[0])
                image_path = os.path.join(video_dir, keyframe_file)
                
                total_keyframes_processed += 1
                
                # Skip if already exists
                if not force_reingest_all and check_if_keyframe_exists_in_db(db_conn, image_path):
                    skipped_count += 1
                    continue
                
                # Get keyframe timing info
                timing_info = keyframe_mapping.get(keyframe_n, {
                    'pts_time': 0.0, 'fps': 30.0, 'frame_idx': 0
                })
                
                # Load and preprocess image
                image = Image.open(image_path).convert('RGB')
                
                # Prepare keyframe data
                keyframe_data = {
                    'video_id': video_id,
                    'keyframe_n': keyframe_n,
                    'image_filename': keyframe_file,
                    'image_path': image_path,
                    'pts_time': timing_info['pts_time'],
                    'fps': timing_info['fps'],
                    'frame_idx': timing_info['frame_idx'],
                    'video_title': video_metadata.get('title', ''),
                    'video_author': video_metadata.get('author', ''),
                    'video_description': video_metadata.get('description', ''),
                    'video_length': video_metadata.get('length', 0),
                    'publish_date': video_metadata.get('publish_date', ''),
                    'watch_url': video_metadata.get('watch_url', ''),
                    'thumbnail_url': video_metadata.get('thumbnail_url', ''),
                }
                
                batch_images.append(image)
                batch_keyframe_data.append(keyframe_data)
                
                # Process batch when full
                if len(batch_images) == batch_size:
                    inserted = process_keyframe_batch_jina(db_conn, batch_images, batch_keyframe_data, model, device)
                    newly_inserted_count += inserted
                    batch_images = []
                    batch_keyframe_data = []
                    
            except Exception as e:
                error_count += 1
                print(f"Error processing {video_id}/{keyframe_file}: {e}")
    
    # Process remaining batch
    if batch_images:
        inserted = process_keyframe_batch_jina(db_conn, batch_images, batch_keyframe_data, model, device)
        newly_inserted_count += inserted
    
    print(f"\nTổng kết:")
    print(f"- Số video: {total_videos}")
    print(f"- Số keyframe tổng cộng: {total_keyframes_processed}")
    print(f"- Số keyframe đã xử lý và thêm mới: {newly_inserted_count}")
    print(f"- Số keyframe bỏ qua (đã tồn tại): {skipped_count}")
    print(f"- Số keyframe lỗi: {error_count}")
    success_rate = (newly_inserted_count / (total_keyframes_processed - skipped_count)) * 100 if (total_keyframes_processed - skipped_count) > 0 else 0
    print(f"- Tỷ lệ thành công: {success_rate:.2f}%")


def search_images_by_image_faiss_jina(query_image_path, faiss_index, faiss_to_db_id_map, db_conn, model, device, top_k=5):
    if not Path(query_image_path).exists():
        print(f"Query image not found: {query_image_path}")
        return []
    if faiss_index is None or faiss_index.ntotal == 0:
        print("FAISS index not available or empty.")
        return []

    try:
        # Use Jina v4 to encode the query image
        query_image_embedding = model.encode_image(
            images=[query_image_path],
            task="retrieval"
        )
        
        # Convert to numpy safely
        query_embedding_np = safe_tensor_to_numpy(query_image_embedding)
        print(f"✅ Thành công tạo embedding cho ảnh query: {query_embedding_np.shape}")
            
        # Jina v4 default format handling
        if len(query_embedding_np.shape) == 2:  # (batch, dim)
            query_embedding_np = query_embedding_np[0]  # Remove batch dimension
            print(f"✅ Query embedding: {query_embedding_np.shape}")
            
        query_embedding_np = query_embedding_np.astype(np.float32)
            
    except Exception as e:
        print(f"Error processing query image {query_image_path}: {e}")
        return []
        
    # Simple FAISS search with single vectors
    print(f"🔍 Bắt đầu tìm kiếm với FAISS index ({faiss_index.ntotal} vectors)...")
    
    query_embedding_np = query_embedding_np.reshape(1, -1)  # Add batch dimension
    faiss.normalize_L2(query_embedding_np)
    
    distances, faiss_indices = faiss_index.search(query_embedding_np, top_k + 1)
    print(f"✅ Hoàn thành tìm kiếm FAISS")
    
    if faiss_indices.size == 0 or faiss_indices[0][0] == -1:
        return []

    retrieved_db_ids = [faiss_to_db_id_map[i] for i in faiss_indices[0] if i != -1]
    metadata_map = get_metadata_for_db_ids(db_conn, retrieved_db_ids)
    
    results = []
    query_image_abs_path = Path(query_image_path).resolve()

    for i, faiss_idx in enumerate(faiss_indices[0]):
        if faiss_idx == -1: continue
        db_id = faiss_to_db_id_map[faiss_idx]
        if db_id in metadata_map:
            meta = metadata_map[db_id]
            # Skip self-match: if the retrieved image is the query image
            if Path(meta['image_path']).resolve() == query_image_abs_path:
                continue
            
            results.append({
                **meta,
                'similarity': distances[0][i]
            })
            if len(results) >= top_k:
                break
    
    print(f"✅ Trả về {len(results)} kết quả sau khi lọc self-match")
    return results

def search_images_by_text_jina(text_query, faiss_index, faiss_to_db_id_map, db_conn, model, device, top_k=10):
    """Search images using text query with Jina v4"""
    if faiss_index is None or faiss_index.ntotal == 0:
        print("FAISS index not available or empty.")
        return []

    try:
        # Use Jina v4 to encode the text query
        text_embedding = model.encode_text(
            texts=[text_query],
            task="retrieval",
            prompt_name="query"
        )
        
        # Convert to numpy safely
        text_embedding_np = safe_tensor_to_numpy(text_embedding)
        print(f"✅ Thành công tạo embedding cho text query: {text_embedding_np.shape}")
            
        # Jina v4 default format handling
        if len(text_embedding_np.shape) == 2:  # (batch, dim)
            text_embedding_np = text_embedding_np[0]  # Remove batch dimension
            print(f"✅ Text embedding: {text_embedding_np.shape}")
            
        text_embedding_np = text_embedding_np.astype(np.float32)
            
    except Exception as e:
        print(f"Error processing text query: {e}")
        return []
        
    text_embedding_np = text_embedding_np.reshape(1, -1)  # Add batch dimension
    faiss.normalize_L2(text_embedding_np)
    distances, faiss_indices = faiss_index.search(text_embedding_np, top_k)
    
    if faiss_indices.size == 0 or faiss_indices[0][0] == -1:
        return []

    retrieved_db_ids = [faiss_to_db_id_map[i] for i in faiss_indices[0] if i != -1]
    metadata_map = get_metadata_for_db_ids(db_conn, retrieved_db_ids)
    
    results = []
    for i, faiss_idx in enumerate(faiss_indices[0]):
        if faiss_idx == -1: continue
        db_id = faiss_to_db_id_map[faiss_idx]
        if db_id in metadata_map:
            meta = metadata_map[db_id]
            results.append({
                **meta,
                'similarity': distances[0][i]
            })
    
    print(f"✅ Text search trả về {len(results)} kết quả")
    return results


def main():
    # --- Configuration ---
    # Jina v4 mode
    
    # Check CUDA availability
    if torch.cuda.is_available():
        device = "cuda"
        print(f"Using device: {device} (CUDA available)")
    else:
        device = "cpu"
        print(f"CUDA not available, falling back to device: {device}")
    
    # Debug prints for path existence
    print("Current working directory:", os.getcwd())
    print("Keyframes directory exists:", Path(KEYFRAMES_ROOT).exists())
    print("Media info directory exists:", Path(MEDIA_INFO_ROOT).exists())
    print("Map keyframes directory exists:", Path(MAP_KEYFRAMES_ROOT).exists())

    # Configuration flags
    # If True, re-processes all keyframes, updates DB, and rebuilds FAISS index.
    # If False, only adds new keyframes to DB.
    FORCE_REPROCESS_ALL_KEYFRAMES = False 
    
    # If True, always rebuilds FAISS index from DB after ingestion, even if index files exist.
    FORCE_REBUILD_FAISS_INDEX = False 

    # --- Database Setup ---
    db_path = DATABASE_FILE
    db_conn = setup_database(db_path)
    print(f"Database setup at {db_path}")

    # --- Load Jina v4 Model ---
    if not _HAS_JINA:
        print("Jina Embeddings not available. pip install transformers>=4.52.0 torch>=2.6.0")
        return
    try:
        print(f"Loading Jina Embeddings v4: {JINA_MODEL_ID}")
        model = AutoModel.from_pretrained(
            JINA_MODEL_ID, 
            trust_remote_code=True, 
            torch_dtype=torch.float16
        )
        model = model.to(device)
        print(f"✅ Jina Embeddings v4 loaded. Embedding dim: {EMBEDDING_DIM}")
    except Exception as e:
        print(f"Error loading Jina model: {e}")
        if db_conn:
            db_conn.close()
        return

    # --- Ingest/Update Embeddings in Database ---
    if not Path(KEYFRAMES_ROOT).exists():
        print(f"Error: Keyframes directory not found: {KEYFRAMES_ROOT}")
    else:
        print("Ingesting/Updating keyframe embeddings in database...")
        ingest_keyframes_to_db_jina(
            db_conn, model, device,
            force_reingest_all=FORCE_REPROCESS_ALL_KEYFRAMES
        )

    # --- Load or Build FAISS Index ---
    faiss_index, faiss_id_map = None, None
    index_file = FAISS_INDEX_FILE
    map_file = FAISS_ID_MAP_FILE
    if FORCE_REBUILD_FAISS_INDEX or not Path(index_file).exists() or not Path(map_file).exists():
        print("Rebuilding FAISS index and map...")
        faiss_index, faiss_id_map = build_and_save_faiss_index(db_conn, index_path=index_file, map_path=map_file)
    else:
        print("Loading existing FAISS index and map...")
        faiss_index, faiss_id_map = load_faiss_index_and_map(index_path=index_file, map_path=map_file)

    if faiss_index is None or faiss_id_map is None or faiss_index.ntotal == 0:
        print("Failed to load or build a valid FAISS index. Search will not be available.")
    else:
        print(f"FAISS setup complete. Index has {faiss_index.ntotal} vectors.")
        
        # --- Interactive Image Search Loop ---
        print("\n" + "="*50)
        print("    INTERACTIVE IMAGE SEARCH & MANAGEMENT    ")
        print("    (Powered by Jina Embeddings v4)")
        print("="*50 + "\n")
        
        while True:
            print("\nOPTIONS:")
            print("1. Search by image (Jina v4)")
            print("1b. Search by text (Jina v4)")
            print("2. Rebuild keyframe database") 
            print("3. Database statistics")
            print("q. Quit")
            
            choice = input("\nYour choice: ").lower()
            
            if choice == 'q':
                break
                
            elif choice == '1':
                print("\n--- IMAGE SEARCH (Jina v4) ---")
                query_img_path = input("Enter path to your query image: ")
                if not Path(query_img_path).is_file():
                    print(f"❌ Error: Image file not found: {query_img_path}")
                    continue
                    
                top_k = 5
                try:
                    top_k = int(input("Number of results to return (default 5): ") or 5)
                except ValueError:
                    print("Invalid number, using default 5")
                    top_k = 5
                
                print("\nSearching for similar images...")
                progress_bar = tqdm(total=3, desc="Search progress")
                
                try:
                    # Step 1: Load and process query image
                    progress_bar.set_description("Processing query image")
                    results = search_images_by_image_faiss_jina(query_img_path, faiss_index, faiss_id_map, db_conn, model, device, top_k)
                    progress_bar.update(3)  # Complete all steps
                    progress_bar.close()
                    
                    if results:
                        print("\n✅ Found matching keyframes:")
                        for i, res in enumerate(results):
                            similarity_pct = res['similarity'] * 100
                            print(f"  {i+1}. Video: {res['video_id']} | Keyframe: {res['keyframe_n']:03d} | Time: {res['pts_time']:.1f}s")
                            print(f"      Title: {res['video_title']}")
                            if res['video_author']:
                                print(f"      Author: {res['video_author']}")
                            if res.get('watch_url'):
                                print(f"      URL: {res['watch_url']}")
                            print(f"      Similarity: {similarity_pct:.2f}%\n")
                    else:
                        print("❌ No matching keyframes found.")
                except Exception as e:
                    progress_bar.close()
                    print(f"❌ Error during search: {e}")
                    
            elif choice == '1b':
                print("\n--- TEXT SEARCH (Jina v4) ---")
                text_query = input("Enter text query: ")
                if not text_query.strip():
                    print("Empty query")
                    continue
                try:
                    results = search_images_by_text_jina(text_query, faiss_index, faiss_id_map, db_conn, model, device, top_k=10)
                    if results:
                        print("\n✅ Top results:")
                        for rank, res in enumerate(results):
                            similarity_pct = res['similarity'] * 100
                            print(f"  {rank+1}. Video: {res['video_id']} | Keyframe: {res['keyframe_n']:03d} | Time: {res['pts_time']:.1f}s")
                            print(f"      Title: {res.get('video_title', '')}")
                            if res.get('video_author'):
                                print(f"      Author: {res['video_author']}")
                            print(f"      Similarity: {similarity_pct:.2f}%\n")
                    else:
                        print("❌ No results found.")
                except Exception as e:
                    print(f"❌ Error in text search: {e}")
                    
            elif choice == '2':
                print("\n--- REBUILD KEYFRAME DATABASE ---")
                if input("This will re-process all keyframes. Continue? (y/n): ").lower() == 'y':
                    print("Re-ingesting all keyframes...")
                    ingest_keyframes_to_db_jina(db_conn, model, device, force_reingest_all=True)
                    print("Rebuilding FAISS index...")
                    faiss_index, faiss_id_map = build_and_save_faiss_index(db_conn, index_file, map_file)
                    print("✅ Database rebuild completed.")
                    
            elif choice == '3':
                print("\n--- DATABASE STATISTICS ---")
                try:
                    # Show database stats with progress
                    stats_progress = tqdm(total=3, desc="Collecting statistics")
                    
                    # Count keyframes
                    cursor = db_conn.cursor()
                    cursor.execute("SELECT COUNT(*) FROM keyframe_embeddings")
                    keyframe_count = cursor.fetchone()[0]
                    stats_progress.update(1)
                    
                    # Count videos
                    cursor.execute("SELECT COUNT(DISTINCT video_id) FROM keyframe_embeddings")
                    video_count = cursor.fetchone()[0]
                    stats_progress.update(1)
                    
                    # Get FAISS info
                    faiss_count = faiss_index.ntotal if faiss_index else 0
                    stats_progress.update(1)
                    stats_progress.close()
                    
                    print(f"\nTotal keyframes in database: {keyframe_count}")
                    print(f"Total videos: {video_count}")
                    print(f"FAISS index size: {faiss_count} vectors")
                    print(f"Model: Jina Embeddings v4 ({EMBEDDING_DIM}D)")
                    
                    # Check if database and FAISS are in sync
                    if keyframe_count != faiss_count:
                        print(f"\n⚠️ Warning: Database ({keyframe_count}) and FAISS index ({faiss_count}) are out of sync.")
                        if input("Would you like to rebuild the FAISS index? (y/n): ").lower() == 'y':
                            print("\nRebuilding FAISS index...")
                            rebuild_progress = tqdm(total=1, desc="Rebuilding index")
                            faiss_index, faiss_id_map = build_and_save_faiss_index(db_conn, index_file, map_file)
                            rebuild_progress.update(1)
                            rebuild_progress.close()
                            print("✅ FAISS index rebuilt successfully.")
                    
                except Exception as e:
                    print(f"❌ Error getting statistics: {e}")
            
            else:
                print("❌ Invalid option. Please try again.")
    
    db_conn.close()
    print("Exited.")

if __name__ == "__main__":
    main()
