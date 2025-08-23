import numpy as np
import sqlite3
import json
import os
import pandas as pd
from pathlib import Path
from tqdm import tqdm

# Configuration
BACKEND_ROOT = "backend"
CLIP_FEATURES_DIR = os.path.join(BACKEND_ROOT, "clip-features-32")
KEYFRAMES_DIR = os.path.join(BACKEND_ROOT, "keyframes")
MAP_KEYFRAMES_DIR = os.path.join(BACKEND_ROOT, "map-keyframes")
MEDIA_INFO_DIR = os.path.join(BACKEND_ROOT, "media-info")

DATABASE_FILE = "image_retrieval.db"
EMBEDDING_DIM = 512  # Adjust based on your actual embedding dimension

def adapt_array(arr):
    """Convert numpy array to bytes for SQLite storage"""
    return arr.tobytes()

def convert_array(text):
    """Convert bytes back to numpy array"""
    return np.frombuffer(text, dtype=np.float32)

# Register adapters for numpy arrays
sqlite3.register_adapter(np.ndarray, adapt_array)
sqlite3.register_converter("array", convert_array)

def setup_database(db_path=DATABASE_FILE):
    """Create database and tables"""
    conn = sqlite3.connect(db_path, detect_types=sqlite3.PARSE_DECLTYPES)
    cursor = conn.cursor()
    
    # Create main table for keyframe data
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS keyframes (
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
            thumbnail_url TEXT,
            channel_id TEXT,
            channel_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Create indexes for faster searching
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_video_id ON keyframes (video_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_image_path ON keyframes (image_path)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_keyframe_n ON keyframes (keyframe_n)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_pts_time ON keyframes (pts_time)')
    
    conn.commit()
    return conn

def load_video_metadata(video_id):
    """Load video metadata from JSON file"""
    json_path = os.path.join(MEDIA_INFO_DIR, f"{video_id}.json")
    if not os.path.exists(json_path):
        print(f"Warning: No metadata found for {video_id}")
        return {}
    
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading metadata for {video_id}: {e}")
        return {}

def load_keyframe_mapping(video_id):
    """Load keyframe timing mapping from CSV file"""
    csv_path = os.path.join(MAP_KEYFRAMES_DIR, f"{video_id}.csv")
    if not os.path.exists(csv_path):
        print(f"Warning: No keyframe mapping found for {video_id}")
        return {}
    
    try:
        df = pd.read_csv(csv_path)
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

def load_embeddings(video_id):
    """Load embeddings from .npy file"""
    npy_path = os.path.join(CLIP_FEATURES_DIR, f"{video_id}.npy")
    if not os.path.exists(npy_path):
        print(f"Warning: No embeddings found for {video_id}")
        return None
    
    try:
        embeddings = np.load(npy_path)
        return embeddings
    except Exception as e:
        print(f"Error loading embeddings for {video_id}: {e}")
        return None

def get_keyframe_files(video_id):
    """Get list of keyframe files for a video"""
    video_dir = os.path.join(KEYFRAMES_DIR, video_id)
    if not os.path.exists(video_dir):
        return []
    
    keyframe_files = []
    for f in sorted(os.listdir(video_dir)):
        if f.endswith(('.jpg', '.jpeg', '.png')):
            keyframe_files.append(f)
    
    return keyframe_files

def insert_keyframe_data(conn, keyframe_data):
    """Insert keyframe data into database"""
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT OR REPLACE INTO keyframes 
            (video_id, keyframe_n, image_filename, image_path, pts_time, fps, frame_idx, embedding,
             video_title, video_author, video_description, video_length, publish_date, 
             watch_url, thumbnail_url, channel_id, channel_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            keyframe_data['video_id'],
            keyframe_data['keyframe_n'],
            keyframe_data['image_filename'],
            keyframe_data['image_path'],
            keyframe_data['pts_time'],
            keyframe_data['fps'],
            keyframe_data['frame_idx'],
            keyframe_data['embedding'],
            keyframe_data['video_title'],
            keyframe_data['video_author'],
            keyframe_data['video_description'],
            keyframe_data['video_length'],
            keyframe_data['publish_date'],
            keyframe_data['watch_url'],
            keyframe_data['thumbnail_url'],
            keyframe_data['channel_id'],
            keyframe_data['channel_url']
        ))
        conn.commit()
        return cursor.lastrowid
    except Exception as e:
        print(f"Error inserting keyframe data for {keyframe_data['image_path']}: {e}")
        return None

def migrate_video_data(conn, video_id):
    """Migrate all data for a specific video"""
    print(f"Processing video: {video_id}")
    
    # Load metadata
    metadata = load_video_metadata(video_id)
    keyframe_mapping = load_keyframe_mapping(video_id)
    embeddings = load_embeddings(video_id)
    keyframe_files = get_keyframe_files(video_id)
    
    if embeddings is None:
        print(f"Skipping {video_id} - no embeddings found")
        return 0
    
    if not keyframe_files:
        print(f"Skipping {video_id} - no keyframe files found")
        return 0
    
    inserted_count = 0
    
    for i, keyframe_file in enumerate(keyframe_files):
        try:
            # Extract keyframe number from filename
            keyframe_n = int(keyframe_file.split('.')[0])
            
            # Check if we have embedding for this keyframe
            if i >= len(embeddings):
                print(f"Warning: No embedding for keyframe {keyframe_n} in {video_id}")
                continue
            
            # Get timing info
            timing_info = keyframe_mapping.get(keyframe_n, {
                'pts_time': 0.0, 
                'fps': 30.0, 
                'frame_idx': i
            })
            
            # Prepare keyframe data
            keyframe_data = {
                'video_id': video_id,
                'keyframe_n': keyframe_n,
                'image_filename': keyframe_file,
                'image_path': os.path.join(KEYFRAMES_DIR, video_id, keyframe_file),
                'pts_time': timing_info['pts_time'],
                'fps': timing_info['fps'],
                'frame_idx': timing_info['frame_idx'],
                'embedding': embeddings[i].astype(np.float32),
                'video_title': metadata.get('title', ''),
                'video_author': metadata.get('author', ''),
                'video_description': metadata.get('description', ''),
                'video_length': metadata.get('length', 0),
                'publish_date': metadata.get('publish_date', ''),
                'watch_url': metadata.get('watch_url', ''),
                'thumbnail_url': metadata.get('thumbnail_url', ''),
                'channel_id': metadata.get('channel_id', ''),
                'channel_url': metadata.get('channel_url', ''),
            }
            
            # Insert into database
            if insert_keyframe_data(conn, keyframe_data):
                inserted_count += 1
                
        except Exception as e:
            print(f"Error processing keyframe {keyframe_file} for {video_id}: {e}")
    
    return inserted_count

def main():
    """Main migration function"""
    print("Starting migration of embeddings to database...")
    
    # Check if directories exist
    if not os.path.exists(BACKEND_ROOT):
        print(f"Error: Backend directory not found: {BACKEND_ROOT}")
        return
    
    if not os.path.exists(CLIP_FEATURES_DIR):
        print(f"Error: CLIP features directory not found: {CLIP_FEATURES_DIR}")
        return
    
    # Setup database
    conn = setup_database()
    print(f"Database setup completed: {DATABASE_FILE}")
    
    # Get all video IDs from .npy files
    video_ids = []
    for filename in os.listdir(CLIP_FEATURES_DIR):
        if filename.endswith('.npy'):
            video_id = filename[:-4]  # Remove .npy extension
            video_ids.append(video_id)
    
    print(f"Found {len(video_ids)} videos to process")
    
    total_inserted = 0
    failed_videos = []
    
    # Process each video
    for video_id in tqdm(video_ids, desc="Migrating videos"):
        try:
            inserted = migrate_video_data(conn, video_id)
            total_inserted += inserted
            if inserted == 0:
                failed_videos.append(video_id)
        except Exception as e:
            print(f"Failed to process video {video_id}: {e}")
            failed_videos.append(video_id)
    
    # Summary
    print(f"\nMigration completed!")
    print(f"Total keyframes inserted: {total_inserted}")
    print(f"Videos processed successfully: {len(video_ids) - len(failed_videos)}")
    print(f"Failed videos: {len(failed_videos)}")
    
    if failed_videos:
        print(f"Failed video IDs: {failed_videos[:10]}...")  # Show first 10
    
    # Database statistics
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM keyframes")
    total_keyframes = cursor.fetchone()[0]
    
    cursor.execute("SELECT COUNT(DISTINCT video_id) FROM keyframes")
    total_videos = cursor.fetchone()[0]
    
    print(f"\nDatabase statistics:")
    print(f"Total keyframes in database: {total_keyframes}")
    print(f"Total videos in database: {total_videos}")
    
    conn.close()
    print(f"Database saved to: {DATABASE_FILE}")

if __name__ == "__main__":
    main()