// Global variables
let currentFrame = null;
let trecvidMode = false;
let currentVideoId = null;

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    // Load statistics on startup
    loadStatistics();
    
    // Setup image file preview
    document.getElementById('imageFile').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(e) {
                document.getElementById('imagePreview').innerHTML = 
                    `<img src="${e.target.result}" alt="Preview" class="img-thumbnail">`;
            };
            reader.readAsDataURL(file);
        }
    });
    
    // Allow Enter key for text search
    document.getElementById('textQuery').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            searchByText();
        }
    });
});

// Load statistics and test backend connection
async function loadStatistics() {
    try {
        // Test health first
        const healthResponse = await fetch('/health');
        const health = await healthResponse.json();
        
        console.log('Backend health:', health);
        
        if (!health.clip_model_loaded) {
            showError('CLIP model not loaded on backend. Please check server logs.');
            return;
        }
        
        if (!health.faiss_index_loaded) {
            showError('FAISS index not loaded. Please run migration script first.');
            return;
        }
        
        // Load statistics
        const response = await fetch('/stats');
        const stats = await response.json();
        
        console.log('Database statistics:', stats);
        
        // Show success message briefly
        if (stats.total_frames > 0) {
            showSuccessMessage(`✅ System ready: ${stats.total_frames} frames from ${stats.total_videos} videos`);
        }
        
    } catch (error) {
        console.error('Error connecting to backend:', error);
        showError('Cannot connect to backend server. Please make sure the server is running on http://localhost:8000');
    }
}

// Search by text
async function searchByText() {
    const query = document.getElementById('textQuery').value.trim();
    const topK = document.getElementById('textTopK').value;
    const videoFilter = document.getElementById('textVideoFilter').value.trim();
    
    if (!query) {
        showError('Please enter a text query');
        return;
    }
    
    showLoading(true);
    
    try {
        const params = new URLSearchParams({
            query: query,
            top_k: topK
        });
        
        if (videoFilter) {
            params.append('video_id', videoFilter);
        }
        
        let url = `/search/text?${params.toString()}`;
        
        const response = await fetch(url, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (response.ok) {
            displayResults(data.results, `Text search: "${query}"`);
        } else {
            const errorMessage = typeof data === 'object' ? 
                (data.detail || data.message || JSON.stringify(data)) : 
                data || 'Search failed';
            showError(errorMessage);
        }
    } catch (error) {
        showError('Network error: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// Search by image
async function searchByImage() {
    const fileInput = document.getElementById('imageFile');
    const topK = document.getElementById('imageTopK').value;
    const videoFilter = document.getElementById('imageVideoFilter').value.trim();
    
    if (!fileInput.files[0]) {
        showError('Please select an image file');
        return;
    }
    
    showLoading(true);
    
    try {
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        
        const params = new URLSearchParams({
            top_k: topK
        });
        
        if (videoFilter) {
            params.append('video_id', videoFilter);
        }
        
        const response = await fetch(`/search/image?${params.toString()}`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (response.ok) {
            displayResults(data.results, `Image search: ${data.filename}`);
        } else {
            const errorMessage = typeof data === 'object' ? 
                (data.detail || data.message || JSON.stringify(data)) : 
                data || 'Search failed';
            showError(errorMessage);
        }
    } catch (error) {
        showError('Network error: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// Display search results
function displayResults(results, searchInfo) {
    const resultsDiv = document.getElementById('searchResults');
    
    if (!results || results.length === 0) {
        resultsDiv.innerHTML = `
            <div class="text-center text-muted py-5">
                <i class="fas fa-search fa-3x mb-3"></i>
                <h4>No results found</h4>
                <p>${searchInfo}</p>
            </div>
        `;
        return;
    }
    
    let html = `
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h4>Search Results</h4>
            <div class="text-muted">
                <i class="fas fa-info-circle me-1"></i>
                ${results.length} results for: ${searchInfo}
            </div>
        </div>
        <div class="row g-4">
    `;
    
    results.forEach((result, index) => {
        const similarityPercent = (result.similarity * 100).toFixed(1);
        const imagePath = `/images/${result.video_id}/${result.image_filename}`;
        
        html += `
            <div class="col-md-6 col-lg-4 col-xl-3">
                <div class="card result-card h-100" onclick="openFrameViewer(${result.id})">
                    <div class="position-relative">
                        <img src="${imagePath}" class="card-img-top result-image" alt="Frame ${result.keyframe_n}">
                        <span class="similarity-badge">${similarityPercent}%</span>
                    </div>
                    <div class="card-body">
                        <div class="video-info">
                            <div class="fw-bold text-truncate" title="${result.video_title}">
                                ${result.video_title || 'Untitled'}
                            </div>
                            <small class="text-muted">${result.video_author || 'Unknown Author'}</small>
                        </div>
                        
                        <div class="frame-info mt-2">
                            <div class="row text-center">
                                <div class="col-4">
                                    <div class="fw-bold">${result.keyframe_n}</div>
                                    <small class="text-muted">Frame</small>
                                </div>
                                <div class="col-4">
                                    <div class="fw-bold">${formatTime(result.pts_time)}</div>
                                    <small class="text-muted">Time</small>
                                </div>
                                <div class="col-4">
                                    <div class="fw-bold">${result.fps.toFixed(0)}</div>
                                    <small class="text-muted">FPS</small>
                                </div>
                            </div>
                        </div>
                        
                        <div class="mt-2">
                            <small class="text-muted">
                                <i class="fas fa-video me-1"></i>${result.video_id}
                            </small>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    resultsDiv.innerHTML = html;
}

// Open frame viewer modal
async function openFrameViewer(frameId) {
    currentFrame = frameId;
    
    try {
        showLoading(true);
        
        console.log(`Opening frame viewer for frame ID: ${frameId}`);
        
        // Test simple endpoint first
        const testResponse = await fetch(`/test/frame/${frameId}`);
        const testData = await testResponse.json();
        console.log('Test endpoint response:', testData);
        
        if (!testData.success) {
            showError('Frame test failed: ' + (testData.error || 'Unknown error'));
            return;
        }
        
        // Get surrounding frames
        const response = await fetch(`/frames/surrounding/${frameId}?window_size=5`);
        
        console.log(`Response status: ${response.status}`);
        
        // Check if response is JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('Non-JSON response:', text);
            showError('Server error: Expected JSON response but got HTML. Check server logs.');
            return;
        }
        
        const data = await response.json();
        console.log('Frame data received:', data);
        
        if (response.ok) {
            displayFrameViewer(data);
            const modal = new bootstrap.Modal(document.getElementById('frameModal'));
            modal.show();
        } else {
            const errorMessage = data.detail || 'Failed to load frame details';
            showError(errorMessage);
        }
    } catch (error) {
        console.error('Error in openFrameViewer:', error);
        if (error.name === 'SyntaxError' && error.message.includes('JSON.parse')) {
            showError('Server returned invalid JSON. This usually means the database is not set up. Please run the migration script first.');
        } else {
            showError('Network error: ' + error.message);
        }
    } finally {
        showLoading(false);
    }
}

// Display frame viewer
function displayFrameViewer(data) {
    const targetFrame = data.target_frame;
    const surroundingFrames = data.surrounding_frames;
    
    const imagePath = `/images/${targetFrame.video_id}/${targetFrame.image_filename}`;
    
    let html = `
        <div class="row">
            <div class="col-md-8">
                <div class="text-center mb-3">
                    <img src="${imagePath}" class="img-fluid rounded" style="max-height: 400px;" alt="Current Frame">
                </div>
                <div class="text-center mb-3">
                    <button class="btn btn-success btn-sm me-2" onclick="showYouTubeVideo()">
                        <i class="fab fa-youtube me-1"></i>Watch on YouTube
                    </button>
                </div>
                
                <div class="surrounding-frames">
    `;
    
    surroundingFrames.forEach(frame => {
        const frameImagePath = `/images/${targetFrame.video_id}/${frame.image_filename}`;
        const currentClass = frame.is_current ? 'current' : '';
        
        html += `
            <div class="surrounding-frame ${currentClass}" onclick="loadFrameDetails('${targetFrame.video_id}', ${frame.keyframe_n})">
                <img src="${frameImagePath}" alt="Frame ${frame.keyframe_n}">
                <div class="small mt-1">
                    <div>Frame ${frame.keyframe_n}</div>
                    <div class="text-muted">${formatTime(frame.pts_time)}</div>
                </div>
            </div>
        `;
    });
    
    html += `
                </div>
            </div>
            
            <div class="col-md-4">
                <div class="card">
                    <div class="card-header">
                        <h6 class="mb-0">Frame Information</h6>
                    </div>
                    <div class="card-body">
                        <div class="metadata-row">
                            <span class="metadata-label">Video ID:</span>
                            <div>${targetFrame.video_id}</div>
                        </div>
                        
                        <div class="metadata-row">
                            <span class="metadata-label">Frame Number:</span>
                            <div>${targetFrame.keyframe_n}</div>
                        </div>
                        
                        <div class="metadata-row">
                            <span class="metadata-label">Timestamp:</span>
                            <div class="timestamp-info">${formatTime(targetFrame.pts_time)}</div>
                        </div>
                        
                        <div class="metadata-row">
                            <span class="metadata-label">FPS:</span>
                            <div>${targetFrame.fps}</div>
                        </div>
                        
                        <div class="metadata-row">
                            <span class="metadata-label">Frame Index:</span>
                            <div>${targetFrame.frame_idx}</div>
                        </div>
                    </div>
                </div>
                
                <div class="card mt-3">
                    <div class="card-header">
                        <h6 class="mb-0">Video Information</h6>
                    </div>
                    <div class="card-body">
                        <div class="metadata-row">
                            <span class="metadata-label">Title:</span>
                            <div class="fw-bold">${targetFrame.video_title || 'Untitled'}</div>
                        </div>
                        
                        <div class="metadata-row">
                            <span class="metadata-label">Author:</span>
                            <div>${targetFrame.video_author || 'Unknown'}</div>
                        </div>
                        
                        <div class="metadata-row">
                            <span class="metadata-label">Duration:</span>
                            <div>${formatTime(targetFrame.video_length)}</div>
                        </div>
                        
                        <div class="metadata-row">
                            <span class="metadata-label">Published:</span>
                            <div>${targetFrame.publish_date || 'Unknown'}</div>
                        </div>
                        
                        ${targetFrame.video_description ? `
                        <div class="metadata-row">
                            <span class="metadata-label">Description:</span>
                            <div class="description-text small">${targetFrame.video_description}</div>
                        </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.getElementById('frameViewer').innerHTML = html;
    
    // Store current video for TRECVID and YouTube functions
    currentVideoId = targetFrame.video_id;
}

// Show YouTube video in frame viewer
function showYouTubeVideo() {
    if (!currentFrame) return;
    
    console.log('Loading YouTube video for frame:', currentFrame);
    
    fetch(`/frame/${currentFrame}`)
        .then(response => {
            console.log('Frame response status:', response.status);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response.json();
        })
        .then(frame => {
            console.log('Frame data received:', frame);
            
            const videoId = extractYouTubeId(frame.watch_url);
            const startTime = Math.floor(frame.pts_time);
            
            console.log('YouTube video ID:', videoId);
            console.log('Start time:', startTime);
            
            if (videoId) {
                const embedUrl = `https://www.youtube.com/embed/${videoId}?start=${startTime}&autoplay=1`;
                
                // Replace the main image with YouTube video
                const mainImageContainer = document.querySelector('#frameViewer .col-md-8 .text-center');
                mainImageContainer.innerHTML = `
                    <div class="youtube-embed mb-3">
                        <iframe src="${embedUrl}" 
                                width="100%" 
                                height="400"
                                frameborder="0" 
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
                    </div>
                    <button class="btn btn-secondary btn-sm" onclick="showFrameImage()">
                        <i class="fas fa-image me-1"></i>Show Original Frame
                    </button>
                `;
            } else {
                showError('Invalid YouTube URL: ' + frame.watch_url);
            }
        })
        .catch(error => {
            console.error('Error loading YouTube video:', error);
            showError('Failed to load video information: ' + error.message);
        });
}

// Show original frame image
function showFrameImage() {
    if (!currentFrame) return;
    
    fetch(`/frame/${currentFrame}`)
        .then(response => response.json())
        .then(frame => {
            const imagePath = `/images/${frame.video_id}/${frame.image_filename}`;
            
            // Replace YouTube video with original image
            const mainImageContainer = document.querySelector('#frameViewer .col-md-8 .text-center');
            mainImageContainer.innerHTML = `
                <div class="mb-3">
                    <img src="${imagePath}" class="img-fluid rounded" style="max-height: 400px;" alt="Current Frame">
                </div>
                <button class="btn btn-success btn-sm" onclick="showYouTubeVideo()">
                    <i class="fab fa-youtube me-1"></i>Watch on YouTube
                </button>
            `;
        })
        .catch(error => {
            console.error('Error loading frame image:', error);
        });
}

// Start TRECVID search mode
function startTRECVIDSearch() {
    if (!currentVideoId) return;
    
    trecvidMode = true;
    
    // Fill video filter fields
    document.getElementById('textVideoFilter').value = currentVideoId;
    document.getElementById('imageVideoFilter').value = currentVideoId;
    
    // Show indicator
    showSearchModeIndicator('TRECVID Mode: ' + currentVideoId);
    
    // Close modal
    bootstrap.Modal.getInstance(document.getElementById('frameModal')).hide();
    
    showSuccess('TRECVID mode activated! Search is now limited to video: ' + currentVideoId);
}

// Exit TRECVID mode
function exitTRECVIDMode() {
    trecvidMode = false;
    currentVideoId = null;
    
    // Clear video filter fields
    document.getElementById('textVideoFilter').value = '';
    document.getElementById('imageVideoFilter').value = '';
    
    // Hide indicator
    document.querySelector('.search-mode-indicator').style.display = 'none';
    
    showSuccess('TRECVID mode deactivated. Searching all videos.');
}

// Utility functions
function formatTime(seconds) {
    if (!seconds && seconds !== 0) return '00:00';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

function extractYouTubeId(url) {
    if (!url) return null;
    
    const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

function showLoading(show) {
    const loading = document.getElementById('loading');
    loading.style.display = show ? 'block' : 'none';
}

function showError(message) {
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = `
        <div class="error-message">
            <i class="fas fa-exclamation-triangle me-2"></i>
            <strong>Error:</strong> ${message}
        </div>
    `;
}

function showSuccess(message) {
    const resultsDiv = document.getElementById('searchResults');
    const existingContent = resultsDiv.innerHTML;
    
    resultsDiv.innerHTML = `
        <div class="success-message">
            <i class="fas fa-check-circle me-2"></i>
            ${message}
        </div>
        ${existingContent}
    `;
    
    // Auto-hide after 3 seconds
    setTimeout(() => {
        const successMsg = document.querySelector('.success-message');
        if (successMsg) successMsg.remove();
    }, 3000);
}

function showSuccessMessage(message) {
    const resultsDiv = document.getElementById('searchResults');
    
    resultsDiv.innerHTML = `
        <div class="success-message">
            <i class="fas fa-check-circle me-2"></i>
            ${message}
        </div>
        <div class="text-center text-muted py-5">
            <i class="fas fa-search fa-3x mb-3"></i>
            <h4>Ready to search</h4>
            <p>Enter a text query or upload an image to get started</p>
        </div>
    `;
    
    // Auto-hide success message after 5 seconds
    setTimeout(() => {
        const successMsg = document.querySelector('.success-message');
        if (successMsg) successMsg.remove();
    }, 5000);
}

function showSearchModeIndicator(text) {
    let indicator = document.querySelector('.search-mode-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'search-mode-indicator trecvid';
        document.body.appendChild(indicator);
    }
    
    indicator.innerHTML = `
        ${text}
        <button class="btn btn-sm btn-outline-dark ms-2" onclick="exitTRECVIDMode()">
            <i class="fas fa-times"></i>
        </button>
    `;
    indicator.style.display = 'block';
}

// Load frame details and update the main view
async function loadFrameDetails(videoId, keyframeNumber) {
    try {
        console.log(`Loading frame details for video: ${videoId}, frame: ${keyframeNumber}`);
        
        // Find frame ID from database by video_id and keyframe_n
        const response = await fetch(`/video/${videoId}/frames`);
        const frames = await response.json();
        
        const targetFrame = frames.find(f => f.keyframe_n === keyframeNumber);
        
        if (!targetFrame) {
            showError(`Frame ${keyframeNumber} not found in video ${videoId}`);
            return;
        }
        
        // Update current frame ID
        currentFrame = targetFrame.id;
        
        // Update main image
        const imagePath = `/images/${videoId}/${String(keyframeNumber).padStart(3, '0')}.jpg`;
        const mainImageContainer = document.querySelector('#frameViewer .col-md-8 .text-center');
        mainImageContainer.innerHTML = `
            <div class="mb-3">
                <img src="${imagePath}" class="img-fluid rounded" style="max-height: 400px;" alt="Frame ${keyframeNumber}">
            </div>
            <div class="text-center mb-2">
                <button class="btn btn-success btn-sm me-2" onclick="showYouTubeVideo()">
                    <i class="fab fa-youtube me-1"></i>Watch on YouTube
                </button>
            </div>
        `;
        
        // Update frame information panel
        updateFrameInfoPanel(targetFrame);
        
        // Update surrounding frames highlighting
        document.querySelectorAll('.surrounding-frame').forEach(frame => {
            frame.classList.remove('current');
        });
        
        // Find and highlight the current frame
        const currentFrameElement = document.querySelector(`.surrounding-frame[onclick*="${keyframeNumber}"]`);
        if (currentFrameElement) {
            currentFrameElement.classList.add('current');
        }
        
    } catch (error) {
        console.error('Error loading frame details:', error);
        showError('Failed to load frame details: ' + error.message);
    }
}

// Show YouTube video at specific frame
function showYouTubeVideoAtFrame(frameId) {
    currentFrame = frameId;
    showYouTubeVideo();
}

// Update frame information panel
function updateFrameInfoPanel(frameData) {
    const frameInfoHtml = `
        <div class="metadata-row">
            <span class="metadata-label">Video ID:</span>
            <div>${frameData.video_id}</div>
        </div>
        
        <div class="metadata-row">
            <span class="metadata-label">Frame Number:</span>
            <div>${frameData.keyframe_n}</div>
        </div>
        
        <div class="metadata-row">
            <span class="metadata-label">Timestamp:</span>
            <div class="timestamp-info">${formatTime(frameData.pts_time)}</div>
        </div>
        
        <div class="metadata-row">
            <span class="metadata-label">FPS:</span>
            <div>${frameData.fps}</div>
        </div>
        
        <div class="metadata-row">
            <span class="metadata-label">Frame Index:</span>
            <div>${frameData.frame_idx}</div>
        </div>
    `;
    
    const videoInfoHtml = `
        <div class="metadata-row">
            <span class="metadata-label">Title:</span>
            <div class="fw-bold">${frameData.video_title || 'Untitled'}</div>
        </div>
        
        <div class="metadata-row">
            <span class="metadata-label">Author:</span>
            <div>${frameData.video_author || 'Unknown'}</div>
        </div>
        
        <div class="metadata-row">
            <span class="metadata-label">Duration:</span>
            <div>${formatTime(frameData.video_length)}</div>
        </div>
        
        <div class="metadata-row">
            <span class="metadata-label">Published:</span>
            <div>${frameData.publish_date || 'Unknown'}</div>
        </div>
        
        ${frameData.video_description ? `
        <div class="metadata-row">
            <span class="metadata-label">Description:</span>
            <div class="description-text small">${frameData.video_description}</div>
        </div>
        ` : ''}
    `;
    
    // Update the panels
    const frameInfoCard = document.querySelector('#frameViewer .col-md-4 .card:first-child .card-body');
    const videoInfoCard = document.querySelector('#frameViewer .col-md-4 .card:last-child .card-body');
    
    if (frameInfoCard) frameInfoCard.innerHTML = frameInfoHtml;
    if (videoInfoCard) videoInfoCard.innerHTML = videoInfoHtml;
}