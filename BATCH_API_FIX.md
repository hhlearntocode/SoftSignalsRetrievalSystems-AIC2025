# Batch API 400 Bad Request - Bug Fix

## 🐛 **Issue Identified**

**Error**: "Batch API failed: 400 Bad Request"  
**Cause**: FastAPI endpoint was expecting `request: dict` but needs proper Pydantic model for request body parsing.

## 🔧 **Fix Applied**

### **1. Added Pydantic Model**
```python
from pydantic import BaseModel

class BatchSimilarityRequest(BaseModel):
    frame_ids: List[int]
    text_queries: List[str]
```

### **2. Fixed API Endpoint**
```python
# ❌ OLD - Incorrect
@app.post("/similarity/batch-matrix")
async def calculate_batch_similarity_matrix(request: dict):
    frame_ids = request.get("frame_ids", [])
    text_queries = request.get("text_queries", [])

# ✅ NEW - Correct  
@app.post("/similarity/batch-matrix")
async def calculate_batch_similarity_matrix(request: BatchSimilarityRequest):
    frame_ids = request.frame_ids
    text_queries = request.text_queries
```

### **3. Enhanced Error Reporting**

**Backend Logging:**
```python
print(f"🚀 Batch similarity computation: {len(text_queries)} queries × {len(frame_ids)} frames")
print(f"📝 Frame IDs: {frame_ids[:5]}...")
print(f"📝 Text queries: {text_queries}")
```

**Frontend Error Details:**
```javascript
if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ Batch API response: ${response.status} ${response.statusText}`);
    console.error(`❌ Error details: ${errorText}`);
    throw new Error(`Batch API failed: ${response.status} ${response.statusText} - ${errorText}`);
}
```

**Request Debugging:**
```javascript
console.log(`📤 Single API call for entire matrix (${frameIds.length} frames × ${textQueries.length} queries)`);
console.log(`📋 Frame IDs sample: ${frameIds.slice(0, 5)} (showing first 5)`);
console.log(`📋 Text queries: ${textQueries}`);
```

## 🚀 **Expected Result**

The batch API should now:
1. ✅ **Accept requests properly** with correct Pydantic validation
2. ✅ **Process data correctly** with frame_ids and text_queries
3. ✅ **Return vectorized similarity matrix** in milliseconds
4. ✅ **Provide detailed logs** for debugging

## 🧪 **Testing**

After restarting the server, you should see:

**Console Output (Success):**
```
🚀 ULTRA-FAST Computing similarity matrix: 3 events × 200 frames
📤 Single API call for entire matrix (200 frames × 3 queries)  
📋 Frame IDs sample: [1234, 1235, 1236, 1237, 1238] (showing first 5)
📋 Text queries: ["person walking", "car driving", "person standing"]
🚀 Batch similarity computation: 3 queries × 200 frames
✅ Vectorized computation completed in 245ms!
⚡ Speed improvement: ~2450x faster than individual API calls
```

**If Still Failing:**
The enhanced error messages will show exactly what's wrong in both browser console and server logs.

## 📋 **Restart Required**

**IMPORTANT**: You need to restart the Python server (`python app.py`) for the Pydantic model changes to take effect!

```bash
# Stop the current server (Ctrl+C)
# Then restart:
python app.py
```

The batch API should now work correctly and provide the ultra-fast similarity matrix computation!