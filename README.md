# Image Retrieval System

Hệ thống tìm kiếm hình ảnh dựa trên video frames sử dụng CLIP embeddings. Hệ thống cho phép tìm kiếm bằng văn bản và hình ảnh, xem các frame xung quanh, và tích hợp với YouTube.

## Tính năng chính

- ✅ **Tìm kiếm bằng văn bản**: Mô tả nội dung bằng ngôn ngữ tự nhiên
- ✅ **Tìm kiếm bằng hình ảnh**: Upload hình ảnh để tìm các frame tương tự
- ✅ **Frame Viewer**: Xem frame được chọn cùng các frame xung quanh
- ✅ **YouTube Integration**: Xem video tại đúng timestamp của frame
- ✅ **TRECVID Search**: Tìm kiếm riêng trong một video cụ thể
- ✅ **Top-K Results**: Chọn số lượng kết quả trả về (5, 10, 20, 50)
- ✅ **Metadata đầy đủ**: Hiển thị thông tin chi tiết về frame và video

## Cấu trúc thư mục

```
├── backend/                    # Dữ liệu backend
│   ├── clip-features-32/       # CLIP embeddings (.npy files)
│   ├── keyframes/              # Frame images (organized by video_id)
│   ├── map-keyframes/          # CSV files mapping frames to timestamps
│   ├── media-info/             # JSON files with video metadata
│   └── embed-code/             # Embedding generation scripts
├── static/                     # Frontend files
│   ├── index.html              # Main web interface
│   ├── style.css               # Styling
│   └── script.js               # JavaScript functionality
├── migrate_embeddings.py       # Database migration script
├── app.py                      # FastAPI backend server
├── requirements.txt            # Python dependencies
├── faiss_id_map.json           # File này chạy từ code migrate_embeddings.py
├── faiss_index.bin             # File này chạy từ code migrate_embeddings.py
├── iamge_retrieval.db          # File này chạy từ code migrate_embeddings.py
└── README.md                   # This file
```

## Cài đặt và Chạy

### Bước 1: Cài đặt dependencies

```bash
# Cài đặt các package Python cần thiết
pip install -r requirements.txt
```

### Bước 2: Migration dữ liệu từ .npy files vào database

```bash
# Chạy script migration để load embeddings vào SQLite database
python migrate_embeddings.py
```

Script này sẽ:

- Đọc tất cả .npy files từ `backend/clip-features-32/`
- Load metadata từ `backend/media-info/` và `backend/map-keyframes/`
- Tạo SQLite database `image_retrieval.db` với tất cả dữ liệu

### Bước 3: Chạy backend server

```bash
# Khởi động FastAPI server
python app.py
```

Hoặc sử dụng uvicorn:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

### Bước 4: Truy cập web interface

Mở trình duyệt và truy cập: `http://localhost:8000`

## Sử dụng hệ thống

### 1. Tìm kiếm bằng văn bản (Text Search)

1. Chọn tab **"Text Search"**
2. Nhập mô tả vào ô **"Text Query"** (ví dụ: "a person walking on the street")
3. Chọn số lượng kết quả muốn hiển thị (Top K)
4. (Tùy chọn) Nhập Video ID để tìm kiếm trong video cụ thể
5. Click **"Search"**

### 2. Tìm kiếm bằng hình ảnh (Image Search)

1. Chọn tab **"Image Search"**
2. Click **"Upload Image"** và chọn hình ảnh từ máy tính
3. Chọn số lượng kết quả muốn hiển thị (Top K)
4. (Tùy chọn) Nhập Video ID để tìm kiếm trong video cụ thể
5. Click **"Search"**

### 3. Xem chi tiết Frame (Frame Viewer)

1. Click vào bất kỳ frame nào trong kết quả tìm kiếm
2. Popup sẽ hiển thị:
   - **Frame hiện tại** ở giữa
   - **Các frame xung quanh** (có thể scroll ngang)
   - **Metadata** chi tiết (timestamp, video info, etc.)

### 4. Xem YouTube Video

1. Trong Frame Viewer, click nút **"Watch on YouTube"**
2. Video sẽ mở trong popup mới và tự động phát từ đúng timestamp của frame

### 5. TRECVID Search Mode

1. Trong Frame Viewer, click nút **"TRECVID Search"**
2. Hệ thống chuyển sang chế độ tìm kiếm riêng trong video đó
3. Tất cả tìm kiếm tiếp theo sẽ chỉ tìm trong video này
4. Click nút **"X"** ở góc phải để thoát khỏi TRECVID mode

## API Endpoints

### Search Endpoints

- `POST /search/text` - Tìm kiếm bằng văn bản
  - Parameters: `query`, `top_k`, `video_id` (optional)
- `POST /search/image` - Tìm kiếm bằng hình ảnh
  - Parameters: `file`, `top_k`, `video_id` (optional)

### Frame Information

- `GET /frame/{frame_id}` - Lấy metadata của một frame
- `GET /frames/surrounding/{frame_id}?window_size=5` - Lấy các frame xung quanh
- `GET /video/{video_id}/frames` - Lấy tất cả frames của một video

### Statistics

- `GET /stats` - Lấy thống kê database

### Static Files

- `/images/{video_id}/{filename}` - Serve frame images
- `/static/` - Serve frontend files

## Troubleshooting

### Lỗi thường gặp

1. **"CLIP model not loaded"**

   - Đảm bảo đã cài đặt `transformers` và có kết nối internet để download model

2. **"FAISS index not available"**

   - Chạy lại migration script: `python migrate_embeddings.py`
   - Kiểm tra file `faiss_index.bin` và `faiss_id_map.json` có được tạo

3. **"Database not found"**

   - Chạy migration script trước khi start server

4. **Hình ảnh không hiển thị**
   - Kiểm tra đường dẫn `backend/keyframes/` có tồn tại
   - Đảm bảo cấu trúc thư mục đúng: `backend/keyframes/{video_id}/{frame}.jpg`

### Kiểm tra logs

```bash
# Xem logs khi chạy server
python app.py

# Hoặc với uvicorn để có logs chi tiết hơn
uvicorn app:app --host 0.0.0.0 --port 8000 --log-level debug
```

### Tối ưu performance

1. **Sử dụng GPU**: Đảm bảo PyTorch có thể sử dụng CUDA nếu có GPU
2. **FAISS optimization**: Có thể sử dụng `faiss-gpu` thay vì `faiss-cpu` nếu có GPU
3. **Database indexing**: Database đã được tạo indexes tự động cho các trường quan trọng

## Development

### Thêm embedding model mới

1. Tạo script embedding mới trong `backend/embed-code/`
2. Generate embeddings và lưu thành .npy files trong `backend/clip-features-32/`
3. Chạy lại migration script

### Tùy chỉnh frontend

- Chỉnh sửa `static/index.html` cho layout
- Chỉnh sửa `static/style.css` cho styling
- Chỉnh sửa `static/script.js` cho functionality

### Mở rộng API

- Thêm endpoints mới trong `app.py`
- Sử dụng Pydantic models để validate data
- FastAPI tự động generate API documentation tại `/docs`

## System Requirements

- **Python**: 3.8+
- **RAM**: Minimum 4GB (8GB+ recommended)
- **Storage**: Depends on dataset size
- **GPU**: Optional (for faster inference)

## License

This project is for educational and research purposes.

## Support

Nếu gặp vấn đề, vui lòng kiểm tra:

1. Logs của server
2. Browser console (F12)
3. Cấu trúc dữ liệu backend
4. Database có được tạo đúng không (`image_retrieval.db`)
