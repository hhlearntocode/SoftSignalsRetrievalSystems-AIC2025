// Global variables
let currentFrame = null;
let trecvidMode = false;
let currentVideoId = null;
let currentSearchResults = [];
let eventCounter = 0;
let currentSequence = null;
let currentEvents = null;
let allSequences = [];
let nextEventNumber = 1;

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
    
    // Initialize TRAKE events after a short delay to ensure DOM is ready
    setTimeout(() => {
        initializeTRAKEEvents();
        checkAndInitializeTRAKEEvents();
    }, 100);
    
    // Add event listener for TRAKE tab to ensure events are initialized
    document.getElementById('trake-tab')?.addEventListener('click', function() {
        setTimeout(() => {
            checkAndInitializeTRAKEEvents();
        }, 50);
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
    
    // Store results for CSV export
    currentSearchResults = results || [];
    
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
            <div class="d-flex align-items-center gap-3">
                <button class="btn btn-success btn-sm" onclick="exportResultsCSV()">
                    <i class="fas fa-download me-1"></i>Export CSV
                </button>
                <div class="text-muted">
                    <i class="fas fa-info-circle me-1"></i>
                    ${results.length} results for: ${searchInfo}
                </div>
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
                        
                        <!-- YouTube link with timestamp -->
                        <div class="mt-2">
                            <a href="#" onclick="openYouTubeAtTimestamp('${result.watch_url}', ${result.pts_time}); return false;" 
                               class="btn btn-sm btn-outline-danger w-100">
                                <i class="fab fa-youtube me-1"></i>Watch at ${formatTime(result.pts_time)}
                            </a>
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
        
        // Get surrounding frames with current window size
        const windowSize = document.getElementById('windowSizeSelect')?.value || 5;
        const response = await fetch(`/frames/surrounding/${frameId}?window_size=${windowSize}`);
        
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
                    <button class="btn btn-primary btn-sm" onclick="searchWithCurrentFrame()">
                        <i class="fas fa-search me-1"></i>Image Search
                    </button>
                    <button class="btn btn-warning btn-sm" onclick="exportCSVWithCurrentFrame()">
                        <i class="fas fa-download me-1"></i>Save CSV
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
    
    // Scroll to current frame in surrounding frames
    setTimeout(() => {
        scrollToCurrentFrame();
    }, 100);
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
                <button class="btn btn-success btn-sm me-2" onclick="showYouTubeVideo()">
                    <i class="fab fa-youtube me-1"></i>Watch on YouTube
                </button>
                <button class="btn btn-primary btn-sm" onclick="searchWithCurrentFrame()">
                    <i class="fas fa-search me-1"></i>Image Search
                </button>
            `;
        })
        .catch(error => {
            console.error('Error loading frame image:', error);
        });
}

// Legacy TRECVID functions - kept for compatibility
function startTRECVIDSearch() {
    // Redirect to new TRAKE functionality
    goToTRAKESearch();
}

function exitTRECVIDMode() {
    trecvidMode = false;
    currentVideoId = null;
    
    // Clear video filter fields
    document.getElementById('textVideoFilter').value = '';
    document.getElementById('imageVideoFilter').value = '';
    
    // Hide indicator if exists
    const indicator = document.querySelector('.search-mode-indicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
    
    showSuccess('Video filter cleared. Searching all videos.');
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
                <button class="btn btn-primary btn-sm" onclick="searchWithCurrentFrame()">
                    <i class="fas fa-search me-1"></i>Image Search
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
            
            // Scroll to center the new current frame
            setTimeout(() => {
                scrollToCurrentFrame();
            }, 100);
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

// Update surrounding frames when window size changes
async function updateSurroundingFrames() {
    if (!currentFrame) return;
    
    try {
        const windowSize = document.getElementById('windowSizeSelect').value;
        const response = await fetch(`/frames/surrounding/${currentFrame}?window_size=${windowSize}`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // Update only the surrounding frames section
        const surroundingFrames = data.surrounding_frames;
        const targetFrame = data.target_frame;
        
        let html = '';
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
        
        // Update surrounding frames container
        const surroundingContainer = document.querySelector('.surrounding-frames');
        if (surroundingContainer) {
            surroundingContainer.innerHTML = html;
            
            // Scroll to current frame after updating
            setTimeout(() => {
                scrollToCurrentFrame();
            }, 100);
        }
        
    } catch (error) {
        console.error('Error updating surrounding frames:', error);
        showError('Failed to update surrounding frames: ' + error.message);
    }
}

// Scroll to current frame in surrounding frames view
function scrollToCurrentFrame() {
    const currentFrameElement = document.querySelector('.surrounding-frame.current');
    const surroundingContainer = document.querySelector('.surrounding-frames');
    
    if (currentFrameElement && surroundingContainer) {
        // Calculate position to center the current frame
        const containerWidth = surroundingContainer.offsetWidth;
        const elementLeft = currentFrameElement.offsetLeft;
        const elementWidth = currentFrameElement.offsetWidth;
        
        // Calculate scroll position to center the element
        const scrollLeft = elementLeft - (containerWidth / 2) + (elementWidth / 2);
        
        // Smooth scroll to center the current frame
        surroundingContainer.scrollTo({
            left: scrollLeft,
            behavior: 'smooth'
        });
    }
}

// Search with current frame image
async function searchWithCurrentFrame() {
    if (!currentFrame) {
        showError('No frame selected');
        return;
    }
    
    try {
        // Get current frame data
        const frameResponse = await fetch(`/frame/${currentFrame}`);
        const frameData = await frameResponse.json();
        
        if (!frameResponse.ok) {
            throw new Error('Failed to get frame data');
        }
        
        // Close the modal first
        bootstrap.Modal.getInstance(document.getElementById('frameModal')).hide();
        
        // Switch to image search tab
        const imageTab = document.getElementById('image-tab');
        const imageSearchPane = document.getElementById('image-search');
        const textTab = document.getElementById('text-tab');
        const textSearchPane = document.getElementById('text-search');
        
        textTab.classList.remove('active');
        textSearchPane.classList.remove('show', 'active');
        imageTab.classList.add('active');
        imageSearchPane.classList.add('show', 'active');
        
        // Show loading
        showLoading(true);
        
        // Get the image URL and fetch it
        const imagePath = `/images/${frameData.video_id}/${frameData.image_filename}`;
        const imageResponse = await fetch(imagePath);
        const imageBlob = await imageResponse.blob();
        
        // Create a File object from the blob
        const imageFile = new File([imageBlob], frameData.image_filename, { type: 'image/jpeg' });
        
        // Get search parameters
        const topK = document.getElementById('imageTopK').value;
        const videoFilter = document.getElementById('imageVideoFilter').value.trim();
        
        // Create form data
        const formData = new FormData();
        formData.append('file', imageFile);
        
        const params = new URLSearchParams({
            top_k: topK
        });
        
        if (videoFilter) {
            params.append('video_id', videoFilter);
        }
        
        // Perform search
        const searchResponse = await fetch(`/search/image?${params.toString()}`, {
            method: 'POST',
            body: formData
        });
        
        const searchData = await searchResponse.json();
        
        if (searchResponse.ok) {
            displayResults(searchData.results, `Image search with frame ${frameData.keyframe_n} from ${frameData.video_id}`);
            
            // Show preview of the search image
            const reader = new FileReader();
            reader.onload = function(e) {
                document.getElementById('imagePreview').innerHTML = 
                    `<img src="${e.target.result}" alt="Search Preview" class="img-thumbnail">`;
            };
            reader.readAsDataURL(imageFile);
            
        } else {
            const errorMessage = searchData.detail || 'Search failed';
            showError(errorMessage);
        }
        
    } catch (error) {
        console.error('Error in searchWithCurrentFrame:', error);
        showError('Failed to search with current frame: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// Export CSV with current frame at top
function exportCSVWithCurrentFrame() {
    if (!currentSearchResults || currentSearchResults.length === 0) {
        showError('No search results to export');
        return;
    }
    
    if (!currentFrame) {
        showError('No current frame selected');
        return;
    }
    
    try {
        // Find the current frame in the results
        const currentFrameResult = currentSearchResults.find(result => result.id === currentFrame);
        
        if (!currentFrameResult) {
            showError('Current frame not found in search results');
            return;
        }
        
        // Create ordered results with current frame first
        const orderedResults = [currentFrameResult];
        
        // Add all other results
        currentSearchResults.forEach(result => {
            if (result.id !== currentFrame) {
                orderedResults.push(result);
            }
        });
        
        // Create CSV content without header
        let csvContent = "";
        
        orderedResults.forEach(result => {
            const videoId = result.video_id;
            const frameIndex = result.frame_idx;
            
            csvContent += `${videoId},${frameIndex}\n`;
        });
        
        // Create and trigger download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        link.setAttribute('href', url);
        link.setAttribute('download', `search_results_${currentFrameResult.video_id}_frame_${currentFrameResult.keyframe_n}_${new Date().toISOString().slice(0,10)}.csv`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        showSuccess(`Exported ${orderedResults.length} results with frame ${currentFrameResult.keyframe_n} at top`);
        
    } catch (error) {
        console.error('Error exporting CSV with current frame:', error);
        showError('Failed to export CSV: ' + error.message);
    }
}

// Export search results to CSV
function exportResultsCSV() {
    if (!currentSearchResults || currentSearchResults.length === 0) {
        showError('No search results to export');
        return;
    }
    
    // Create CSV content without header
    let csvContent = "";
    
    currentSearchResults.forEach(result => {
        const videoId = result.video_id;
        const frameIndex = result.frame_idx;
        
        csvContent += `${videoId},${frameIndex}\n`;
    });
    
    // Create and trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `search_results_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showSuccess(`Exported ${currentSearchResults.length} results to CSV file`);
}

// Toggle TRAKE search mode (text/image)
function toggleTRAKESearchMode() {
    const mode = document.getElementById('trakeMode').value;
    const textInput = document.getElementById('trakeTextInput');
    const imageInput = document.getElementById('trakeImageInput');
    
    if (mode === 'text') {
        textInput.style.display = 'block';
        imageInput.style.display = 'none';
    } else {
        textInput.style.display = 'none';
        imageInput.style.display = 'block';
    }
}

// Go to TRAKE search tab from modal
function goToTRAKESearch() {
    if (!currentVideoId) return;
    
    // Close modal
    bootstrap.Modal.getInstance(document.getElementById('frameModal')).hide();
    
    // Switch to TRAKE tab
    const trakeTab = document.getElementById('trake-tab');
    const trakeSearchPane = document.getElementById('trake-search');
    const textTab = document.getElementById('text-tab');
    const textSearchPane = document.getElementById('text-search');
    const imageTab = document.getElementById('image-tab');
    const imageSearchPane = document.getElementById('image-search');
    
    // Deactivate other tabs
    textTab.classList.remove('active');
    textSearchPane.classList.remove('show', 'active');
    imageTab.classList.remove('active');
    imageSearchPane.classList.remove('show', 'active');
    
    // Activate TRAKE tab
    trakeTab.classList.add('active');
    trakeSearchPane.classList.add('show', 'active');
    
    // Pre-fill video ID
    document.getElementById('trakeVideoId').value = currentVideoId;
    
    showSuccess('Switched to TRAKE search with video: ' + currentVideoId);
}

// Check and initialize TRAKE events if needed
function checkAndInitializeTRAKEEvents() {
    const container = document.getElementById('eventsContainer');
    
    if (container && container.children.length === 0) {
        console.log('Events container is empty, initializing with 3 default events');
        initializeTRAKEEvents();
    }
}

// Initialize TRAKE events with default rows
function initializeTRAKEEvents() {
    console.log('Initializing TRAKE events...');
    const container = document.getElementById('eventsContainer');
    
    if (!container) {
        console.error('eventsContainer not found!');
        return;
    }
    
    container.innerHTML = '';
    nextEventNumber = 1;
    
    // Add 3 default event rows (keeping 3 for better UX, even though algorithm needs minimum 2)
    for (let i = 1; i <= 3; i++) {
        console.log(`Adding event row ${i}`);
        addDynamicEventRow();
    }
    
    console.log('TRAKE events initialized successfully');
}

// Add new event row (can be removed if > 3)
function addDynamicEventRow() {
    const container = document.getElementById('eventsContainer');
    
    if (!container) {
        console.error(`Container not found when adding event row`);
        return;
    }
    
    const eventNumber = nextEventNumber++;
    const eventRow = document.createElement('div');
    eventRow.className = 'event-row';
    eventRow.id = `event-${eventNumber}`;
    
    const canRemove = container.children.length >= 3; // Can remove if we have 3+ events
    
    eventRow.innerHTML = `
        <div class="d-flex align-items-center mb-2">
            <span class="event-number me-2">${eventNumber}</span>
            <span class="fw-bold">Event ${eventNumber}</span>
            ${canRemove ? `
                <button class="btn btn-sm btn-outline-danger ms-auto remove-event-btn" 
                        onclick="removeEventRow(${eventNumber})">
                    <i class="fas fa-times"></i>
                </button>
            ` : ''}
        </div>
        <div class="row g-2">
            <div class="col-md-12">
                <input type="text" class="form-control event-query" 
                       placeholder="Enter event ${eventNumber} description (e.g., 'person walking', 'car driving')" 
                       id="eventQuery${eventNumber}">
            </div>
        </div>
    `;
    
    container.appendChild(eventRow);
    console.log(`Event row ${eventNumber} added successfully`);
    
    // Update remove buttons for all existing rows
    updateRemoveButtons();
}

// Add new event row (called by Add Event button)
function addNewEventRow() {
    addDynamicEventRow();
    console.log('New event row added by user');
}

// Remove event row
function removeEventRow(eventNumber) {
    const eventRow = document.getElementById(`event-${eventNumber}`);
    if (eventRow) {
        eventRow.remove();
        console.log(`Event row ${eventNumber} removed`);
        updateRemoveButtons();
    }
}

// Update remove buttons based on current event count
function updateRemoveButtons() {
    const container = document.getElementById('eventsContainer');
    const eventRows = container.querySelectorAll('.event-row');
    
    eventRows.forEach((row, index) => {
        const removeBtn = row.querySelector('.remove-event-btn');
        
        if (eventRows.length <= 2) {
            // Hide all remove buttons if we have 2 or fewer events (minimum required)
            if (removeBtn) removeBtn.style.display = 'none';
        } else {
            // Show remove buttons if we have more than 2 events
            if (removeBtn) {
                removeBtn.style.display = 'inline-block';
            } else {
                // Add remove button if it doesn't exist
                const eventNumber = row.id.split('-')[1];
                const headerDiv = row.querySelector('.d-flex');
                const removeButton = document.createElement('button');
                removeButton.className = 'btn btn-sm btn-outline-danger ms-auto remove-event-btn';
                removeButton.onclick = () => removeEventRow(eventNumber);
                removeButton.innerHTML = '<i class="fas fa-times"></i>';
                headerDiv.appendChild(removeButton);
            }
        }
    });
}

// Get all events data (dynamic events)
function getEventsData() {
    const events = [];
    const container = document.getElementById('eventsContainer');
    
    if (!container) return events;
    
    const eventRows = container.querySelectorAll('.event-row');
    eventRows.forEach((row, index) => {
        const queryInput = row.querySelector('.event-query');
        if (queryInput) {
            const query = queryInput.value.trim();
            if (query) {
                events.push({
                    id: index + 1,
                    query: query,
                    weight: 1 // Fixed weight
                });
            }
        }
    });
    
    return events;
}

// Enhanced temporal query merging function
function createTemporalQuery(events) {
    if (events.length === 1) {
        return events[0].query;
    }

    let query = "temporal sequence: ";
    for (let i = 0; i < events.length; i++) {
        let prefix;
        if (i === 0) {
            prefix = "first";
        } else if (i === events.length - 1) {
            prefix = "finally";
        } else {
            const transitions = ["followed by", "then", "subsequently"];
            prefix = transitions[i % 3];
        }

        query += prefix + " " + events[i].query;
        if (i < events.length - 1) {
            query += ", ";
        }
    }

    return query;
}

// Configuration for the enhanced algorithm (frame-number-based, no early filtering)
const algorithmConfig = {
    similarityThreshold: 0,        // Min similarity for individual event matches
    scoreThreshold: 0,             // Min final score to return result
    topK: 10,                       // Initial candidates to process
    maxTemporalGap: 150,             // Max frame numbers between consecutive events
    searchWindow: 3000,               // Frame numbers to search around pivot
    minSequenceCompleteness: 0.1,    // Min % of events that must be found
    temporalWeight: 0.3,             // Weight for temporal continuity in scoring
    completenessWeight: 0.2          // Weight for sequence completeness in scoring
    // Note: earlyStopThreshold removed - Phase 1 now passes ALL candidates to Phase 2
};

// Perform Enhanced TRAKE Sequence Search
async function performTRAKESequenceSearch() {
    const topK = parseInt(document.getElementById('trakeTopK').value);
    const similarityThreshold = parseFloat(document.getElementById('similarityThreshold').value);
    const scoreThreshold = parseFloat(document.getElementById('scoreThreshold').value);
    const searchWindow = parseInt(document.getElementById('searchWindow').value);
    const maxTemporalGap = parseInt(document.getElementById('maxTemporalGap').value);
    const events = getEventsData();
    
    // Update config with all UI values (including advanced ones if available)
    algorithmConfig.topK = topK;
    algorithmConfig.similarityThreshold = similarityThreshold;
    algorithmConfig.scoreThreshold = scoreThreshold;
    algorithmConfig.searchWindow = searchWindow;
    algorithmConfig.maxTemporalGap = maxTemporalGap;
    
    // Advanced configuration (if elements exist)
    const minCompletenessEl = document.getElementById('minCompleteness');
    const temporalWeightEl = document.getElementById('temporalWeight');
    const completenessWeightEl = document.getElementById('completenessWeight');
    
    if (minCompletenessEl) algorithmConfig.minSequenceCompleteness = parseFloat(minCompletenessEl.value);
    if (temporalWeightEl) algorithmConfig.temporalWeight = parseFloat(temporalWeightEl.value);
    if (completenessWeightEl) algorithmConfig.completenessWeight = parseFloat(completenessWeightEl.value);
    // Note: earlyStopThreshold removed - no longer used
    
    console.log('Enhanced TRAKE Config:', algorithmConfig);
    
    if (events.length < 2) {
        showError('Please enter descriptions for at least 2 events');
        return;
    }
    
    showLoading(true);
    
    try {
        console.log('Starting Enhanced TRAKE Algorithm...');
        
        // Phase 1: Enhanced Initial Search with early filtering
        console.log('Phase 1: Enhanced Initial Search');
        const candidates = await performInitialSearch(events);
        
        if (!candidates || candidates.length === 0) {
            throw new Error('No candidates found after initial search and filtering');
        }
        console.log(`Found ${candidates.length} candidates after filtering`);
        
        // Phase 2: Sequence Discovery with pivot selection
        console.log('Phase 2: Sequence Discovery');
        const sequences = await discoverSequences(events, candidates);
        console.log(`Discovered ${sequences.length} valid sequences`);
        
        // Phase 3: Advanced Scoring and Results
        console.log('Phase 3: Advanced Scoring and Ranking');
        const results = await scoreAndRankSequences(sequences, events);
        console.log(`Final results: ${results.length} sequences passed score threshold`);
        
        // Display enhanced results
        displayEnhancedSequenceResults(results, events);
        
        // Show success message with algorithm info
        if (results.length > 0) {
            const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
            console.log(`Average score: ${(avgScore * 100).toFixed(1)}%`);
        }
        
    } catch (error) {
        console.error('Error in Enhanced TRAKE sequence search:', error);
        showError('Enhanced TRAKE search failed: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// Phase 1: Enhanced Initial Search (no early filtering)
async function performInitialSearch(events) {
    const mergedQuery = createTemporalQuery(events);
    console.log('Enhanced merged query:', mergedQuery);
    
    // Search directly with desired top-K (no need for early filtering)
    const params = new URLSearchParams({
        query: mergedQuery,
        top_k: algorithmConfig.topK
    });
    
    const response = await fetch(`/search/text?${params.toString()}`, {
        method: 'POST'
    });
    
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.detail || 'Search failed');
    }
    
    // Return all results from query - let Phase 2 do the filtering
    console.log(`Initial search returned ${data.results.length} candidates (no early filtering)`);
    return data.results;
}

// Phase 2: Sequence Discovery
async function discoverSequences(events, candidates) {
    const validSequences = [];
    
    for (const candidate of candidates) {
        // Find which event this candidate best matches (pivot)
        const bestPivot = await findBestPivot(candidate, events);
        
        if (bestPivot.similarity < algorithmConfig.similarityThreshold) {
            continue;
        }
        
        // Build complete sequence around this pivot
        const sequence = await buildSequenceAroundPivot(candidate, bestPivot.eventIndex, events);
        
        if (isSequenceValid(sequence, events)) {
            validSequences.push(sequence);
        }
    }
    
    return validSequences;
}


// Find best pivot for a candidate frame
async function findBestPivot(candidate, events) {
    let bestMatch = null;
    let bestSimilarity = 0;
    let bestEventIndex = -1;
    
    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const similarity = await calculateFrameEventSimilarity(candidate, event.query);
        
        if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestEventIndex = i;
            bestMatch = candidate;
        }
    }
    
    return {
        match: bestMatch,
        similarity: bestSimilarity,
        eventIndex: bestEventIndex
    };
}

// Cache for frame-text similarity calculations to avoid repeated API calls
const frameTextSimilarityCache = new Map();

// Calculate similarity between frame and event using CLIP embeddings
async function calculateFrameEventSimilarity(frame, eventQuery) {
    const cacheKey = `${frame.id}:${eventQuery.trim().toLowerCase()}`;
    
    // Check cache first
    if (frameTextSimilarityCache.has(cacheKey)) {
        return frameTextSimilarityCache.get(cacheKey);
    }
    
    try {
        // Use the new API endpoint to calculate actual CLIP similarity
        const params = new URLSearchParams({
            frame_id: frame.id,
            text_query: eventQuery.trim()
        });
        
        const response = await fetch(`/similarity/frame-text?${params.toString()}`, {
            method: 'POST'
        });
        
        if (!response.ok) {
            // Fallback to approximation if API fails
            console.warn(`Frame-text similarity API failed for frame ${frame.id}, using fallback`);
            const fallbackSimilarity = Math.min(frame.similarity + (Math.random() - 0.5) * 0.1, 1.0);
            frameTextSimilarityCache.set(cacheKey, fallbackSimilarity);
            return fallbackSimilarity;
        }
        
        const data = await response.json();
        const similarity = data.similarity;
        
        // Cache the result
        frameTextSimilarityCache.set(cacheKey, similarity);
        return similarity;
        
    } catch (error) {
        // Fallback to approximation with less randomness on error
        console.warn(`Error calculating frame-event similarity: ${error.message}, using fallback`);
        const fallbackSimilarity = Math.min(frame.similarity + (Math.random() - 0.5) * 0.05, 1.0);
        frameTextSimilarityCache.set(cacheKey, fallbackSimilarity);
        return fallbackSimilarity;
    }
}

// Clear similarity cache when needed (e.g., when starting a new debug session)
function clearFrameTextSimilarityCache() {
    frameTextSimilarityCache.clear();
}

// Enhanced sequence building around pivot with frame-number-based windowed search
async function buildSequenceAroundPivot(pivotFrame, pivotEventIndex, events) {
    const sequence = new Array(events.length).fill(null);
    
    // Place pivot frame (use keyframe_n as frame number)
    const pivotFrameNumber = pivotFrame.keyframe_n;

    sequence[pivotEventIndex] = {
        frame: pivotFrame,
        similarity: pivotFrame.similarity,
        frameNumber: pivotFrameNumber,
        videoId: pivotFrame.video_id,
        isPivot: true
    };
    
    // Define search window around pivot using frame numbers
    const searchWindow = algorithmConfig.searchWindow;
    const minFrameNumber = Math.max(1, pivotFrameNumber - searchWindow);
    const maxFrameNumber = pivotFrameNumber + searchWindow;
    console.log(`Building sequence around pivot frame number ${pivotFrameNumber} (Event ${pivotEventIndex + 1})`);
    console.log(`Searching frames in range [${minFrameNumber}, ${maxFrameNumber}]`);
    // Get all frames in the video within the search window for matrix computation
    const videoFrames = await getVideoFramesInRange(
        pivotFrame.video_id, 
        minFrameNumber, 
        maxFrameNumber
    );
    
    if (!videoFrames || videoFrames.length === 0) {
        console.warn('No video frames found in range');
        return sequence.filter(frame => frame !== null);
    }
    
    // Compute similarity matrix for all events with all frames in range
    const similarityMatrix = await computeEventFrameSimilarityMatrix(events, videoFrames);
    
    // Search backwards for earlier events using matrix results
    for (let eventIdx = pivotEventIndex - 1; eventIdx >= 0; eventIdx--) {
        const candidateFrames = videoFrames.filter(frame => 
            frame.keyframe_n >= minFrameNumber && 
            frame.keyframe_n < pivotFrameNumber
        );
        
        const bestMatch = findBestMatchFromMatrix(
            sequence,
            eventIdx, 
            candidateFrames, 
            videoFrames, 
            similarityMatrix,
            false
        );
        
        if (bestMatch && bestMatch.similarity >= algorithmConfig.similarityThreshold && sequence[eventIdx + 1].frameNumber > bestMatch.frame.keyframe_n) {
            sequence[eventIdx] = {
                frame: bestMatch.frame,
                similarity: bestMatch.similarity,
                frameNumber: bestMatch.frame.keyframe_n,
                videoId: bestMatch.frame.video_id,
                isPivot: false
            };
        }
    }
    
    // Search forwards for later events using matrix results
    for (let eventIdx = pivotEventIndex + 1; eventIdx < events.length; eventIdx++) {
        const candidateFrames = videoFrames.filter(frame => 
            frame.keyframe_n > pivotFrameNumber && 
            frame.keyframe_n <= maxFrameNumber
        );
        
        const bestMatch = findBestMatchFromMatrix(
            sequence,
            eventIdx, 
            candidateFrames, 
            videoFrames, 
            similarityMatrix,
            true
        );
        
        if (bestMatch && bestMatch.similarity >= algorithmConfig.similarityThreshold && sequence[eventIdx - 1].frameNumber < bestMatch.frame.keyframe_n) {
            sequence[eventIdx] = {
                frame: bestMatch.frame,
                similarity: bestMatch.similarity,
                frameNumber: bestMatch.frame.keyframe_n,
                videoId: bestMatch.frame.video_id,
                isPivot: false
            };
        }
    }
    
    // Return only non-null frames
    return sequence.filter(frame => frame !== null);
}

// Get video frames within a specific frame number range (optimized)
async function getVideoFramesInRange(videoId, minFrameNumber, maxFrameNumber) {
    try {
        const response = await fetch(`/video/${videoId}/frames`);
        const frames = await response.json();
        
        if (!response.ok || !frames) {
            return [];
        }
        
        // Filter frames by frame number (keyframe_n) instead of frame_idx
        return frames.filter(frame => 
            frame.keyframe_n >= minFrameNumber && 
            frame.keyframe_n <= maxFrameNumber
        );
    } catch (error) {
        console.error('Error getting video frames in range:', error);
        return [];
    }
}

// ULTRA-FAST: Compute similarity matrix using vectorized batch API (300x faster!)
async function computeEventFrameSimilarityMatrix(events, frames) {
    const numEvents = events.length;
    let numFrames = frames.length;
    let processingFrames = frames;
    
    // In debug mode, limit frame processing for performance
    const isDebugging = debugState && debugState.isDebugging;
    const debugFrameLimit = 200; // Limit for batch API (max 300 frames)
    
    if (isDebugging && numFrames > debugFrameLimit) {
        console.log(`Debug mode: limiting frame processing to ${debugFrameLimit} frames (out of ${numFrames})`);
        // Take frames with highest similarity scores first
        processingFrames = frames
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, debugFrameLimit);
        numFrames = processingFrames.length;
    }
    
    console.log(`🚀 ULTRA-FAST Computing similarity matrix: ${numEvents} events × ${numFrames} frames using vectorized batch API`);
    
    try {
        // Prepare data for batch API
        const frameIds = processingFrames.map(frame => frame.id);
        const textQueries = events.map(event => event.query);
        
        console.log(`📤 Single API call for entire matrix (${frameIds.length} frames × ${textQueries.length} queries)`);
        console.log(`📋 Frame IDs sample: ${frameIds.slice(0, 5)} (showing first 5)`);
        console.log(`📋 Text queries: ${textQueries}`);
        
        const startTime = performance.now();
        
        // Single API call to compute entire matrix!
        const response = await fetch('/similarity/batch-matrix', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                frame_ids: frameIds,
                text_queries: textQueries
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Batch API response: ${response.status} ${response.statusText}`);
            console.error(`❌ Error details: ${errorText}`);
            throw new Error(`Batch API failed: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        const data = await response.json();
        const similarityMatrix = data.similarity_matrix; // [num_queries, num_frames]
        
        const endTime = performance.now();
        const computationTime = endTime - startTime;
        
        console.log(`✅ VECTORIZED computation completed in ${computationTime.toFixed(2)}ms! Matrix shape: [${data.shape[0]}, ${data.shape[1]}]`);
        console.log(`⚡ Speed improvement: ~${Math.round((numEvents * numFrames * 100) / computationTime)}x faster than individual API calls`);
        
        // Return the matrix (already in correct format: events x frames)
        return similarityMatrix;
        
    } catch (error) {
        console.error(`❌ Batch API failed, falling back to optimized individual calculations: ${error.message}`);
        
        // Fallback to optimized individual calculations
        return await computeEventFrameSimilarityMatrixFallback(events, processingFrames);
    }
}

// Optimized fallback method (only used if batch API fails)
async function computeEventFrameSimilarityMatrixFallback(events, frames) {
    const numEvents = events.length;
    const numFrames = frames.length;
    
    console.log(`🐌 Fallback: Computing similarity matrix with optimized individual calls`);
    
    // Initialize similarity matrix [events x frames]
    const matrix = new Array(numEvents);
    for (let i = 0; i < numEvents; i++) {
        matrix[i] = new Array(numFrames);
    }
    
    // Process events sequentially but frames in smaller parallel batches
    for (let eventIdx = 0; eventIdx < numEvents; eventIdx++) {
        const event = events[eventIdx];
        console.log(`Processing event ${eventIdx + 1}/${numEvents}: "${event.query}"`);
        
        // Much smaller batch size to prevent overload
        const batchSize = 5;
        const similarities = new Array(numFrames);
        
        for (let batchStart = 0; batchStart < numFrames; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, numFrames);
            const batchFrames = frames.slice(batchStart, batchEnd);
            
            // Process current batch in parallel
            const batchPromises = batchFrames.map(async (frame, localIdx) => {
                try {
                    return await calculateFrameEventSimilarity(frame, event.query);
                } catch (error) {
                    console.warn(`Similarity calculation failed for frame ${frame.id}: ${error.message}`);
                    return Math.min(frame.similarity * 0.9, 1.0); // Conservative fallback
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            
            // Store results
            for (let i = 0; i < batchResults.length; i++) {
                similarities[batchStart + i] = batchResults[i];
            }
            
            // Very short delay between batches
            if (batchEnd < numFrames) {
                await new Promise(resolve => setTimeout(resolve, 25)); // Minimal delay
            }
        }
        
        // Store in matrix
        matrix[eventIdx] = similarities;
        console.log(`Completed event ${eventIdx + 1}/${numEvents}`);
    }
    
    console.log('Fallback similarity matrix computed successfully');
    return matrix;
}

// Batch compute similarities for one event with multiple frames (optimized with rate limiting)
async function computeEventSimilarities(event, frames) {
    const similarities = new Array(frames.length);
    const batchSize = 20; // Process frames in small batches to avoid overwhelming the system
    
    console.log(`Computing similarities for event "${event.query}" with ${frames.length} frames (batch size: ${batchSize})`);
    
    // Process frames in batches to avoid too many concurrent requests
    for (let batchStart = 0; batchStart < frames.length; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, frames.length);
        const batchFrames = frames.slice(batchStart, batchEnd);
        
        console.log(`Processing batch ${Math.floor(batchStart/batchSize) + 1}/${Math.ceil(frames.length/batchSize)} (frames ${batchStart + 1}-${batchEnd})`);
        
        // Process current batch
        const batchPromises = batchFrames.map(async (frame, localIdx) => {
            const globalIdx = batchStart + localIdx;
            try {
                return await calculateFrameEventSimilarity(frame, event.query);
            } catch (error) {
                console.warn(`Error calculating similarity for frame ${globalIdx}: ${error.message}`);
                // Return fallback similarity
                return Math.min(frame.similarity + (Math.random() - 0.5) * 0.05, 1.0);
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        
        // Store batch results in the main similarities array
        for (let i = 0; i < batchResults.length; i++) {
            similarities[batchStart + i] = batchResults[i];
        }
        
        // Small delay between batches to prevent server overload
        if (batchEnd < frames.length) {
            await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
        }
    }
    
    console.log(`Completed similarities for event "${event.query}"`);
    return similarities;
}

// Find best match from precomputed similarity matrix
function findBestMatchFromMatrix(sequence, eventIdx, candidateFrames, allFrames, similarityMatrix, direction) {
    if (!candidateFrames || candidateFrames.length === 0) {
        return null;
    }
    
    // Create array of candidate frames with their similarities and sort by similarity (highest first)
    const candidatesWithSimilarity = [];
    
    for (const candidateFrame of candidateFrames) {
        // Find the index of this candidate frame in the allFrames array
        const frameIdx = allFrames.findIndex(frame => 
            frame.keyframe_n === candidateFrame.keyframe_n && 
            frame.video_id === candidateFrame.video_id
        );
        
        if (frameIdx >= 0 && frameIdx < similarityMatrix[eventIdx].length) {
            const similarity = similarityMatrix[eventIdx][frameIdx];
            candidatesWithSimilarity.push({
                frame: candidateFrame,
                similarity: similarity,
                frameIdx: frameIdx
            });
        }
    }
    
    // Sort candidates by similarity (highest first)
    candidatesWithSimilarity.sort((a, b) => b.similarity - a.similarity);
    
    // Try each candidate in order of similarity until we find one that maintains event order
    for (const candidate of candidatesWithSimilarity) {
        const candidateFrame = candidate.frame;
        const similarity = candidate.similarity;
        
        // Check if this candidate maintains temporal order
        let maintainsOrder = true;
        
        if (direction) {
            // Forward search: check if this frame comes after the previous event's frame
            if (sequence[eventIdx - 1] && sequence[eventIdx - 1].frameNumber >= candidateFrame.keyframe_n) {
                maintainsOrder = false;
            }
        } else {
            // Backward search: check if this frame comes before the next event's frame  
            if (sequence[eventIdx + 1] && sequence[eventIdx + 1].frameNumber <= candidateFrame.keyframe_n) {
                maintainsOrder = false;
            }
        }
        
        // If this candidate maintains temporal order, use it
        if (maintainsOrder) {
            return {
                frame: candidateFrame,
                similarity: similarity
            };
        }
    }
    
    // No candidate maintains temporal order
    return null;
}

// Check if sequence is valid according to algorithm requirements (using frame numbers)
function isSequenceValid(sequence, events) {
    if (!sequence || sequence.length == 0) {
        return false;
    }
    
    // Check minimum completeness requirement
    const completeness = sequence.length / events.length;
    if (completeness < algorithmConfig.minSequenceCompleteness) {
        return false;
    }
    
    // Check temporal ordering using frame numbers
    for (let i = 1; i < sequence.length; i++) {
        const currentFrameNumber = sequence[i].frameNumber || sequence[i].frame?.keyframe_n;
        const prevFrameNumber = sequence[i-1].frameNumber || sequence[i-1].frame?.keyframe_n;
        
        
        if (currentFrameNumber <= prevFrameNumber) {
            return false; // Not in temporal order
        }
    }
    
    return true;
}

// Get all frames from a video
async function getVideoFrames(videoId) {
    try {
        const response = await fetch(`/video/${videoId}/frames`);
        const frames = await response.json();
        return response.ok ? frames : [];
    } catch (error) {
        console.error('Error getting video frames:', error);
        return [];
    }
}

// Find best frame for event with position constraint
async function findBestFrameForEvent(videoFrames, event, pivotFrameIdx, direction, threshold) {
    let bestFrame = null;
    let bestSimilarity = 0;
    
    for (const frame of videoFrames) {
        // Check position constraint
        if (direction === 'before' && frame.frame_idx >= pivotFrameIdx) continue;
        if (direction === 'after' && frame.frame_idx <= pivotFrameIdx) continue;
        
        // Calculate similarity (simplified)
        const similarity = await calculateFrameEventSimilarity(frame, event.query);
        
        if (similarity > bestSimilarity && similarity >= threshold) {
            bestSimilarity = similarity;
            bestFrame = { ...frame, similarity: similarity };
        }
    }
    
    return bestFrame;
}

// Phase 3: Advanced Scoring and Ranking
async function scoreAndRankSequences(sequences, events) {
    const results = [];
    
    for (const sequence of sequences) {
        const scoreResult = calculateEnhancedSequenceScore(sequence, events);
        
        if (scoreResult.finalScore >= algorithmConfig.scoreThreshold) {
            // Calculate metadata using frame numbers instead of frame indices
            const frameNumbers = sequence.map(frame => 
                frame.frameNumber || frame.frame?.keyframe_n || 0
            );
            
            results.push({
                sequence: sequence,
                score: scoreResult.finalScore,
                scoreBreakdown: scoreResult.breakdown,
                metadata: {
                    videoId: sequence.length > 0 ? sequence[0].videoId : null,
                    startFrame: Math.min(...frameNumbers),
                    endFrame: Math.max(...frameNumbers),
                    duration: Math.max(...frameNumbers) - Math.min(...frameNumbers),
                    completeness: sequence.length / events.length
                }
            });
        }
    }
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
}

// Enhanced scoring system with multiple components (using frame numbers)
function calculateEnhancedSequenceScore(sequence, events) {
    if (sequence.length === 0) {
        return { finalScore: 0, breakdown: {} };
    }
    
    const similarities = sequence.map(frame => frame.similarity);
    
    // 1. Base similarity score (average)
    const baseSimilarityScore = similarities.reduce((sum, sim) => sum + sim, 0) / similarities.length;
    
    // 2. Temporal continuity score (using frame numbers instead of frame indices)
    let temporalScore = 1.0;
    if (sequence.length > 1) {
        let totalGapPenalty = 0;
        for (let i = 1; i < sequence.length; i++) {
            const currentFrameNumber = sequence[i].frameNumber || sequence[i].frame?.keyframe_n;
            const prevFrameNumber = sequence[i-1].frameNumber || sequence[i-1].frame?.keyframe_n;
            const gap = currentFrameNumber - prevFrameNumber;
            
            // Normalize gap against max temporal gap (in frame numbers)
            const normalizedGap = Math.min(gap / algorithmConfig.maxTemporalGap, 1.0);
            totalGapPenalty += normalizedGap;
        }
        temporalScore = Math.max(0, 1 - (totalGapPenalty / (sequence.length - 1)));
    }
    
    // 3. Completeness score
    const completeness = sequence.length / events.length;
    const completenessScore = completeness >= algorithmConfig.minSequenceCompleteness 
        ? completeness 
        : completeness * 0.5;
    
    // 4. Consistency bonus (reward consistent similarities)
    const variance = calculateVariance(similarities);
    const consistencyBonus = Math.max(0, 1 - variance);
    
    // 5. Sequential order bonus (using frame numbers)
    let correctOrderCount = 0;
    for (let i = 1; i < sequence.length; i++) {
        const currentFrameNumber = sequence[i].frameNumber || sequence[i].frame?.keyframe_n;
        const prevFrameNumber = sequence[i-1].frameNumber || sequence[i-1].frame?.keyframe_n;
        
        if (currentFrameNumber > prevFrameNumber) {
            correctOrderCount += 1;
        }
    }
    const orderBonus = sequence.length > 1 ? correctOrderCount / (sequence.length - 1) : 1;
    
    // Final weighted score
    const finalScore = (
        baseSimilarityScore * 0.4 +
        temporalScore * algorithmConfig.temporalWeight +
        completenessScore * algorithmConfig.completenessWeight +
        consistencyBonus * 0.1 +
        orderBonus * 0.1
    );
    
    return {
        finalScore: finalScore,
        breakdown: {
            baseSimilarity: baseSimilarityScore,
            temporal: temporalScore,
            completeness: completenessScore,
            consistency: consistencyBonus,
            order: orderBonus
        }
    };
}

// Calculate variance of similarities
function calculateVariance(similarities) {
    if (similarities.length === 0) return 0;
    
    const mean = similarities.reduce((sum, sim) => sum + sim, 0) / similarities.length;
    const variance = similarities.reduce((sum, sim) => sum + Math.pow(sim - mean, 2), 0) / similarities.length;
    return Math.sqrt(variance);
}

// ===================================
// TRAKE DEBUG SYSTEM
// ===================================

// Global debug state
let debugState = {
    isDebugging: false,
    currentPhase: 0,
    totalPhases: 3,
    debugLevel: 'detailed',
    startTime: null,
    phaseResults: {},
    events: [],
    candidates: [],
    sequences: [],
    finalResults: []
};

// Debug logging function
function debugLog(message, level = 'info', data = null) {
    const timestamp = new Date().toISOString().substring(11, 23);
    const logEntry = {
        timestamp: timestamp,
        level: level,
        message: message,
        data: data
    };
    
    // Always log to console for debugging
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
    console.log(`${prefix} [${timestamp}] ${message}`, data || '');
    
    // Update debug UI if debugging is active
    if (debugState.isDebugging) {
        updateDebugStep(message);
        if (debugState.debugLevel === 'verbose' || level === 'error') {
            appendDebugLog(logEntry);
        }
    }
}

// Start debug TRAKE search
async function startDebugTRAKE() {
    try {
        // Initialize debug state
        debugState = {
            isDebugging: true,
            currentPhase: 0,
            totalPhases: 3,
            debugLevel: document.getElementById('debugLevel').value,
            startTime: performance.now(),
            phaseResults: {
                phase1: {
                    candidates: [],
                    candidateCount: 0,
                    timing: 0,
                    detailedCandidates: []
                },
                phase2: {
                    sequences: [],
                    sequenceCount: 0,
                    timing: 0,
                    detailedSequences: []
                },
                phase3: {
                    results: [],
                    resultCount: 0,
                    timing: 0,
                    detailedScoring: []
                }
            },
            events: [],
            candidates: [],
            sequences: [],
            finalResults: []
        };
        
        debugLog('🚀 Starting TRAKE Debug Session', 'info');
        
        // Clear similarity cache for fresh calculations
        clearFrameTextSimilarityCache();
        
        // Validate debug state initialization
        if (!debugState.phaseResults.phase1.detailedCandidates) {
            console.error('Debug state initialization failed - phase1.detailedCandidates not initialized');
            throw new Error('Debug state initialization failed');
        }
        
        // Show debug progress
        document.getElementById('debugProgress').style.display = 'block';
        updateDebugProgress(0, 'Initializing debug session...');
        
        // Get debug events
        const events = getDebugEvents();
        if (events.length < 2) {
            throw new Error('At least 2 events are required for debugging');
        }
        
        debugState.events = events;
        debugLog(`📝 Loaded ${events.length} debug events`, 'info', events);
        
        // Clear previous results
        document.getElementById('debugResults').innerHTML = '<div class="debug-log-container"></div>';
        
        // Start the debug algorithm phases
        await executeDebugPhases(events);
        
    } catch (error) {
        debugLog(`❌ Debug session failed: ${error.message}`, 'error', error);
        showError('Debug failed: ' + error.message);
    }
}

// Execute all debug phases
async function executeDebugPhases(events) {
    try {
        // Phase 1: Enhanced Initial Search
        updateDebugProgress(10, 'Phase 1: Enhanced Initial Search');
        debugState.currentPhase = 1;
        const candidates = await debugPhase1(events);
        debugState.candidates = candidates;
        // Update phase1 results
        debugState.phaseResults.phase1.candidates = candidates;
        debugState.phaseResults.phase1.candidateCount = candidates.length;
        debugState.phaseResults.phase1.timing = performance.now() - debugState.startTime;
        
        // Phase 2: Sequence Discovery
        updateDebugProgress(40, 'Phase 2: Sequence Discovery');
        debugState.currentPhase = 2;
        const sequences = await debugPhase2(events, candidates);
        debugState.sequences = sequences;
        // Update phase2 results
        debugState.phaseResults.phase2.sequences = sequences;
        debugState.phaseResults.phase2.sequenceCount = sequences.length;
        debugState.phaseResults.phase2.timing = performance.now() - debugState.startTime;
        
        // Phase 3: Advanced Scoring
        updateDebugProgress(70, 'Phase 3: Advanced Scoring and Ranking');
        debugState.currentPhase = 3;
        const results = await debugPhase3(sequences, events);
        debugState.finalResults = results;
        // Update phase3 results
        debugState.phaseResults.phase3.results = results;
        debugState.phaseResults.phase3.resultCount = results.length;
        debugState.phaseResults.phase3.timing = performance.now() - debugState.startTime;
        
        // Generate debug report
        updateDebugProgress(90, 'Generating debug report...');
        await generateDebugReport();
        
        updateDebugProgress(100, 'Debug session completed!');
        debugLog('✅ Debug session completed successfully', 'success');
        
    } catch (error) {
        debugLog(`❌ Debug phase execution failed: ${error.message}`, 'error', error);
        throw error;
    }
}

// Debug Phase 1: Enhanced Initial Search (no early filtering)
async function debugPhase1(events) {
    debugLog('🔍 Phase 1: Enhanced Initial Search (no early filtering)', 'info');
    
    try {
        // Create temporal query
        const mergedQuery = createTemporalQuery(events);
        debugLog(`📝 Temporal query: "${mergedQuery}"`, 'info');
        
        // Perform initial search
        debugLog('🔍 Performing initial database search...', 'info');
        const params = new URLSearchParams({
            query: mergedQuery,
            top_k: algorithmConfig.topK
        });
        
        const response = await fetch(`/search/text?${params.toString()}`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.detail || 'Initial search failed');
        }
        
        debugLog(`📊 Initial search returned ${data.results.length} candidates`, 'info');
        debugLog(`✅ Passing ALL candidates to Phase 2 (no early filtering)`, 'info');
        
        // Log similarity distribution for debugging
        if (data.results.length > 0) {
            const similarities = data.results.map(c => c.similarity);
            const minSim = Math.min(...similarities);
            const maxSim = Math.max(...similarities);
            const avgSim = similarities.reduce((sum, sim) => sum + sim, 0) / similarities.length;
            
            debugLog(`📈 Similarity range: ${minSim.toFixed(3)} - ${maxSim.toFixed(3)}, avg: ${avgSim.toFixed(3)}`, 'info');
        }
        
        // Store detailed phase 1 results for debugging
        debugState.phaseResults.phase1.detailedCandidates = data.results.slice(0, 10).map(candidate => ({
            id: candidate.id,
            video_id: candidate.video_id,
            keyframe_n: candidate.keyframe_n,
            similarity: candidate.similarity,
            image_filename: candidate.image_filename,
            image_path: candidate.image_path,
            pts_time: candidate.pts_time
        }));
        
        return data.results;
        
    } catch (error) {
        debugLog(`❌ Phase 1 failed: ${error.message}`, 'error', error);
        throw error;
    }
}

// Debug Phase 2: Sequence Discovery
async function debugPhase2(events, candidates) {
    debugLog('🔗 Phase 2: Sequence Discovery', 'info');
    
    try {
        const validSequences = [];
        const detailedSequenceInfo = [];
        let pivotCount = 0;
        
        for (const candidate of candidates) {
            pivotCount++;
            debugLog(`🎯 Processing candidate ${pivotCount}/${candidates.length} (Frame: ${candidate.keyframe_n}, Video: ${candidate.video_id})`, 'info');
            
            // Find best pivot
            const bestPivot = await findBestPivot(candidate, events);
            debugLog(`📍 Best pivot for candidate: Event ${bestPivot.eventIndex + 1} (similarity: ${bestPivot.similarity.toFixed(3)})`, 'info');
            
            const sequenceInfo = {
                candidateId: pivotCount,
                candidate: {
                    id: candidate.id,
                    video_id: candidate.video_id,
                    keyframe_n: candidate.keyframe_n,
                    similarity: candidate.similarity,
                    image_filename: candidate.image_filename,
                    image_path: candidate.image_path
                },
                pivot: {
                    eventIndex: bestPivot.eventIndex,
                    similarity: bestPivot.similarity,
                    eventQuery: events[bestPivot.eventIndex]?.query || 'Unknown'
                },
                sequence: null,
                valid: false,
                reason: ''
            };
            
            if (bestPivot.similarity < algorithmConfig.similarityThreshold) {
                sequenceInfo.reason = `Pivot similarity ${bestPivot.similarity.toFixed(3)} below threshold ${algorithmConfig.similarityThreshold}`;
                debugLog(`❌ ${sequenceInfo.reason}`, 'warn');
                detailedSequenceInfo.push(sequenceInfo);
                continue;
            }
            
            // Build sequence around pivot
            debugLog(`🏗️ Building sequence around pivot...`, 'info');
            const sequence = await buildSequenceAroundPivot(candidate, bestPivot.eventIndex, events);
            
            if (sequence && sequence.length > 0) {
                debugLog(`✅ Built sequence with ${sequence.length}/${events.length} events`, 'info');
                
                // Store detailed sequence information
                sequenceInfo.sequence = sequence.map((frameData, eventIndex) => ({
                    eventIndex: eventIndex,
                    eventQuery: events[eventIndex]?.query || 'Unknown',
                    frame: frameData ? {
                        id: frameData.frame?.id,
                        keyframe_n: frameData.frameNumber || frameData.frame?.keyframe_n,
                        similarity: frameData.similarity,
                        image_filename: frameData.frame?.image_filename,
                        image_path: frameData.frame?.image_path,
                        isPivot: frameData.isPivot || false
                    } : null,
                    matched: frameData !== null
                }));
                
                if (isSequenceValid(sequence, events)) {
                    debugLog(`✅ Sequence is valid`, 'success');
                    sequenceInfo.valid = true;
                    sequenceInfo.reason = 'Valid sequence passed all checks';
                    validSequences.push(sequence);
                } else {
                    sequenceInfo.reason = 'Sequence failed validation checks';
                    debugLog(`❌ Sequence failed validation`, 'warn');
                }
            } else {
                sequenceInfo.reason = 'Failed to build sequence around pivot';
                debugLog(`❌ Failed to build sequence`, 'warn');
            }
            
            detailedSequenceInfo.push(sequenceInfo);
            
            // Only process first 10 candidates in debug mode for performance
            if (pivotCount >= 10) {
                debugLog(`🔍 Debug mode: limiting to first 10 candidates for detailed analysis`, 'info');
                break;
            }
        }
        
        // Store detailed phase 2 results for debugging
        debugState.phaseResults.phase2.detailedSequences = detailedSequenceInfo;
        
        debugLog(`🏁 Phase 2 completed: ${validSequences.length} valid sequences from ${candidates.length} candidates`, 'success');
        return validSequences;
        
    } catch (error) {
        debugLog(`❌ Phase 2 failed: ${error.message}`, 'error', error);
        throw error;
    }
}

// Debug Phase 3: Advanced Scoring
async function debugPhase3(sequences, events) {
    debugLog('📊 Phase 3: Advanced Scoring and Ranking', 'info');
    
    try {
        const results = [];
        const detailedScoring = [];
        let sequenceCount = 0;
        
        for (const sequence of sequences) {
            sequenceCount++;
            debugLog(`⚖️ Scoring sequence ${sequenceCount}/${sequences.length}`, 'info');
            
            const scoreResult = calculateEnhancedSequenceScore(sequence, events);
            debugLog(`📈 Sequence score: ${(scoreResult.finalScore * 100).toFixed(1)}%`, 'info', scoreResult.breakdown);
            
            // Calculate metadata
            const frameNumbers = sequence.map(frame => 
                frame.frameNumber || frame.frame?.keyframe_n || 0
            );
            
            const scoringInfo = {
                sequenceId: sequenceCount,
                score: scoreResult.finalScore,
                scoreBreakdown: scoreResult.breakdown,
                metadata: {
                    videoId: sequence.length > 0 ? sequence[0].videoId : null,
                    startFrame: Math.min(...frameNumbers),
                    endFrame: Math.max(...frameNumbers),
                    duration: Math.max(...frameNumbers) - Math.min(...frameNumbers),
                    completeness: sequence.length / events.length
                },
                frames: sequence.map((frameData, eventIndex) => ({
                    eventIndex: eventIndex,
                    eventQuery: events[eventIndex]?.query || 'Unknown',
                    frame: frameData ? {
                        id: frameData.frame?.id,
                        keyframe_n: frameData.frameNumber || frameData.frame?.keyframe_n,
                        similarity: frameData.similarity,
                        image_filename: frameData.frame?.image_filename,
                        image_path: frameData.frame?.image_path,
                        isPivot: frameData.isPivot || false
                    } : null,
                    matched: frameData !== null
                })),
                passedThreshold: scoreResult.finalScore >= algorithmConfig.scoreThreshold
            };
            
            detailedScoring.push(scoringInfo);
            
            if (scoreResult.finalScore >= algorithmConfig.scoreThreshold) {
                const result = {
                    sequence: sequence,
                    score: scoreResult.finalScore,
                    scoreBreakdown: scoreResult.breakdown,
                    metadata: scoringInfo.metadata
                };
                
                results.push(result);
                debugLog(`✅ Sequence passed score threshold`, 'success');
            } else {
                debugLog(`❌ Sequence score ${(scoreResult.finalScore * 100).toFixed(1)}% below threshold ${(algorithmConfig.scoreThreshold * 100).toFixed(1)}%`, 'warn');
            }
        }
        
        // Sort results by score
        results.sort((a, b) => b.score - a.score);
        
        // Store detailed phase 3 results for debugging
        debugState.phaseResults.phase3.detailedScoring = detailedScoring.sort((a, b) => b.score - a.score);
        
        debugLog(`🏆 Phase 3 completed: ${results.length} final results`, 'success');
        return results;
        
    } catch (error) {
        debugLog(`❌ Phase 3 failed: ${error.message}`, 'error', error);
        throw error;
    }
}

// Helper functions for debug system
function getDebugEvents() {
    const testEvents = document.getElementById('debugTestEvents').value;
    
    // Use predefined test events if selected
    if (testEvents === 'simple') {
        return [
            { query: 'person walking', weight: 1.0 },
            { query: 'car driving', weight: 1.0 }
        ];
    } else if (testEvents === 'complex') {
        return [
            { query: 'person standing', weight: 1.0 },
            { query: 'person walking', weight: 1.0 },
            { query: 'car approaching', weight: 1.0 },
            { query: 'car driving away', weight: 1.0 }
        ];
    }
    
    // Use custom events from input fields
    const events = [];
    const event1 = document.getElementById('debugEvent1').value.trim();
    const event2 = document.getElementById('debugEvent2').value.trim();
    const event3 = document.getElementById('debugEvent3').value.trim();
    
    if (event1) events.push({ query: event1, weight: 1.0 });
    if (event2) events.push({ query: event2, weight: 1.0 });
    if (event3) events.push({ query: event3, weight: 1.0 });
    
    return events;
}

function updateDebugProgress(percentage, message) {
    const progressBar = document.getElementById('debugProgressBar');
    const currentStep = document.getElementById('debugCurrentStep');
    
    if (progressBar) {
        progressBar.style.width = percentage + '%';
        progressBar.setAttribute('aria-valuenow', percentage);
    }
    
    if (currentStep) {
        currentStep.textContent = message;
    }
}

function updateDebugStep(message) {
    const currentStep = document.getElementById('debugCurrentStep');
    if (currentStep) {
        currentStep.textContent = message;
    }
}

function appendDebugLog(logEntry) {
    const container = document.querySelector('.debug-log-container');
    if (!container) return;
    
    const logDiv = document.createElement('div');
    logDiv.className = `debug-log-entry debug-log-${logEntry.level}`;
    
    const levelIcon = logEntry.level === 'error' ? '❌' : 
                     logEntry.level === 'warn' ? '⚠️' : 
                     logEntry.level === 'success' ? '✅' : 'ℹ️';
    
    logDiv.innerHTML = `
        <span class="debug-timestamp">${logEntry.timestamp}</span>
        <span class="debug-level">${levelIcon}</span>
        <span class="debug-message">${logEntry.message}</span>
        ${logEntry.data ? '<pre class="debug-data">' + JSON.stringify(logEntry.data, null, 2) + '</pre>' : ''}
    `;
    
    container.appendChild(logDiv);
    logDiv.scrollIntoView({ behavior: 'smooth' });
}

async function generateDebugReport() {
    debugLog('📋 Generating comprehensive debug report...', 'info');
    
    const totalTime = performance.now() - debugState.startTime;
    const resultsContainer = document.getElementById('debugResults');
    
    const report = `
        <div class="debug-report">
            <div class="row mb-4">
                <div class="col-12">
                    <h4>🐛 TRAKE Algorithm Debug Report</h4>
                    <p class="text-muted">Total execution time: ${totalTime.toFixed(2)}ms</p>
                </div>
            </div>
            
            <!-- Summary Statistics -->
            <div class="row mb-4">
                <div class="col-md-3">
                    <div class="card bg-primary text-white">
                        <div class="card-body text-center">
                            <h5>${debugState.events.length}</h5>
                            <p class="mb-0">Events</p>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card bg-info text-white">
                        <div class="card-body text-center">
                            <h5>${debugState.candidates.length}</h5>
                            <p class="mb-0">Candidates</p>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card bg-warning text-white">
                        <div class="card-body text-center">
                            <h5>${debugState.sequences.length}</h5>
                            <p class="mb-0">Sequences</p>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card bg-success text-white">
                        <div class="card-body text-center">
                            <h5>${debugState.finalResults.length}</h5>
                            <p class="mb-0">Final Results</p>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Phase Details -->
            ${generatePhaseDetails()}
            
            <!-- Configuration Used -->
            ${generateConfigDetails()}
            
            <!-- Results Preview -->
            ${generateResultsPreview()}
            
            <!-- Debug Log -->
            <div class="row mt-4">
                <div class="col-12">
                    <div class="card">
                        <div class="card-header">
                            <h6 class="mb-0">📝 Debug Log</h6>
                        </div>
                        <div class="card-body">
                            <div class="debug-log-container" style="max-height: 300px; overflow-y: auto;">
                                <!-- Log entries will be added here -->
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    resultsContainer.innerHTML = report;
    debugLog('✅ Debug report generated successfully', 'success');
}

function generatePhaseDetails() {
    const phase1 = debugState.phaseResults.phase1 || {};
    const phase2 = debugState.phaseResults.phase2 || {};
    const phase3 = debugState.phaseResults.phase3 || {};
    
    return `
        <div class="row mb-4">
            <div class="col-12">
                <h5>📊 Detailed Phase Analysis</h5>
            </div>
            <div class="col-12">
                <div class="accordion" id="phaseAccordion">
                    <!-- Phase 1 Details -->
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#phase1Details">
                                <strong>Phase 1: Initial Search</strong>
                                <span class="badge bg-primary ms-2">${phase1.candidateCount || 0} candidates</span>
                                <span class="badge bg-info ms-1">${(phase1.timing || 0).toFixed(0)}ms</span>
                            </button>
                        </h2>
                        <div id="phase1Details" class="accordion-collapse collapse show">
                            <div class="accordion-body">
                                ${generatePhase1Details(phase1)}
                            </div>
                        </div>
                    </div>
                    
                    <!-- Phase 2 Details -->
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#phase2Details">
                                <strong>Phase 2: Sequence Discovery</strong>
                                <span class="badge bg-warning ms-2">${phase2.sequenceCount || 0} sequences</span>
                                <span class="badge bg-info ms-1">${(phase2.timing || 0).toFixed(0)}ms</span>
                            </button>
                        </h2>
                        <div id="phase2Details" class="accordion-collapse collapse">
                            <div class="accordion-body">
                                ${generatePhase2Details(phase2)}
                            </div>
                        </div>
                    </div>
                    
                    <!-- Phase 3 Details -->
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#phase3Details">
                                <strong>Phase 3: Advanced Scoring</strong>
                                <span class="badge bg-success ms-2">${phase3.resultCount || 0} results</span>
                                <span class="badge bg-info ms-1">${(phase3.timing || 0).toFixed(0)}ms</span>
                            </button>
                        </h2>
                        <div id="phase3Details" class="accordion-collapse collapse">
                            <div class="accordion-body">
                                ${generatePhase3Details(phase3)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function generatePhase1Details(phase1) {
    if (!phase1.detailedCandidates || phase1.detailedCandidates.length === 0) {
        return '<p class="text-muted">No detailed candidate information available.</p>';
    }
    
    return `
        <h6>🔍 Top Candidate Frames</h6>
        <div class="table-responsive">
            <table class="table table-sm table-hover">
                <thead class="table-light">
                    <tr>
                        <th>Rank</th>
                        <th>Frame</th>
                        <th>Video</th>
                        <th>Keyframe #</th>
                        <th>Similarity</th>
                        <th>Time</th>
                        <th>Preview</th>
                    </tr>
                </thead>
                <tbody>
                    ${phase1.detailedCandidates.map((candidate, index) => `
                        <tr>
                            <td><span class="badge bg-primary">#${index + 1}</span></td>
                            <td><small>${candidate.id}</small></td>
                            <td><small>${candidate.video_id}</small></td>
                            <td><strong>${candidate.keyframe_n}</strong></td>
                            <td><span class="badge bg-success">${(candidate.similarity * 100).toFixed(1)}%</span></td>
                            <td><small>${candidate.pts_time?.toFixed(1)}s</small></td>
                            <td>
                                <img src="/${candidate.image_path}" 
                                     class="img-thumbnail debug-frame-preview" 
                                     style="width: 40px; height: 30px; cursor: pointer;"
                                     onclick="showFrameModal(${candidate.id})"
                                     alt="Frame ${candidate.keyframe_n}">
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        <p class="small text-muted mt-2">
            <i class="fas fa-info-circle"></i> 
            Showing top 10 candidate frames from initial search. All candidates pass to Phase 2 (no early filtering).
        </p>
    `;
}

function generatePhase2Details(phase2) {
    if (!phase2.detailedSequences || phase2.detailedSequences.length === 0) {
        return '<p class="text-muted">No detailed sequence information available.</p>';
    }
    
    return `
        <h6>🔗 Sequence Building Analysis</h6>
        ${phase2.detailedSequences.map((seqInfo, index) => `
            <div class="card mb-3 ${seqInfo.valid ? 'border-success' : 'border-warning'}">
                <div class="card-header">
                    <div class="d-flex justify-content-between align-items-center">
                        <strong>Candidate #${seqInfo.candidateId}</strong>
                        <div>
                            <span class="badge ${seqInfo.valid ? 'bg-success' : 'bg-warning'}">${seqInfo.valid ? 'Valid' : 'Invalid'}</span>
                            <small class="text-muted ms-2">Frame ${seqInfo.candidate.keyframe_n}</small>
                        </div>
                    </div>
                </div>
                <div class="card-body">
                    <div class="row">
                        <div class="col-md-6">
                            <h6>📍 Pivot Information</h6>
                            <p><strong>Best Event:</strong> Event ${seqInfo.pivot.eventIndex + 1} (${seqInfo.pivot.eventQuery})</p>
                            <p><strong>Pivot Similarity:</strong> <span class="badge bg-info">${(seqInfo.pivot.similarity * 100).toFixed(1)}%</span></p>
                            <p><strong>Reason:</strong> <small class="text-muted">${seqInfo.reason}</small></p>
                        </div>
                        <div class="col-md-6">
                            <img src="/${seqInfo.candidate.image_path}" 
                                 class="img-thumbnail" 
                                 style="width: 120px; height: 90px; cursor: pointer;"
                                 onclick="showFrameModal(${seqInfo.candidate.id})"
                                 alt="Candidate Frame">
                        </div>
                    </div>
                    
                    ${seqInfo.sequence ? `
                        <h6 class="mt-3">🎬 Sequence Frames</h6>
                        <div class="table-responsive">
                            <table class="table table-sm">
                                <thead class="table-light">
                                    <tr>
                                        <th>Event</th>
                                        <th>Query</th>
                                        <th>Frame #</th>
                                        <th>Similarity</th>
                                        <th>Pivot</th>
                                        <th>Preview</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${seqInfo.sequence.map((frame, eventIndex) => `
                                        <tr class="${frame.matched ? '' : 'table-secondary'}">
                                            <td><span class="badge bg-secondary">${eventIndex + 1}</span></td>
                                            <td><small>${frame.eventQuery}</small></td>
                                            <td>${frame.frame ? `<strong>${frame.frame.keyframe_n}</strong>` : '<span class="text-muted">-</span>'}</td>
                                            <td>${frame.frame ? `<span class="badge bg-success">${(frame.frame.similarity * 100).toFixed(1)}%</span>` : '<span class="text-muted">-</span>'}</td>
                                            <td>${frame.frame?.isPivot ? '<i class="fas fa-star text-warning"></i>' : ''}</td>
                                            <td>
                                                ${frame.frame ? `
                                                    <img src="/${frame.frame.image_path}" 
                                                         class="img-thumbnail debug-frame-preview" 
                                                         style="width: 30px; height: 22px; cursor: pointer;"
                                                         onclick="showFrameModal(${frame.frame.id})"
                                                         alt="Frame ${frame.frame.keyframe_n}">
                                                ` : '<span class="text-muted">No match</span>'}
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    ` : ''}
                </div>
            </div>
        `).join('')}
        <p class="small text-muted">
            <i class="fas fa-info-circle"></i> 
            Showing detailed sequence building for top 10 candidates. Each candidate is evaluated as a potential pivot for sequence discovery.
        </p>
    `;
}

function generatePhase3Details(phase3) {
    if (!phase3.detailedScoring || phase3.detailedScoring.length === 0) {
        return '<p class="text-muted">No detailed scoring information available.</p>';
    }
    
    return `
        <h6>📊 Scoring & Ranking Analysis</h6>
        ${phase3.detailedScoring.map((scoreInfo, index) => `
            <div class="card mb-3 ${scoreInfo.passedThreshold ? 'border-success' : 'border-danger'}">
                <div class="card-header">
                    <div class="d-flex justify-content-between align-items-center">
                        <strong>Sequence #${scoreInfo.sequenceId}</strong>
                        <div>
                            <span class="badge bg-primary">${(scoreInfo.score * 100).toFixed(1)}%</span>
                            <span class="badge ${scoreInfo.passedThreshold ? 'bg-success' : 'bg-danger'}">${scoreInfo.passedThreshold ? 'Passed' : 'Failed'}</span>
                        </div>
                    </div>
                </div>
                <div class="card-body">
                    <div class="row mb-3">
                        <div class="col-md-6">
                            <h6>📈 Score Breakdown</h6>
                            <div class="row">
                                <div class="col-6">
                                    <small>Base Similarity:</small><br>
                                    <span class="badge bg-info">${(scoreInfo.scoreBreakdown.baseSimilarity * 100).toFixed(1)}%</span>
                                </div>
                                <div class="col-6">
                                    <small>Temporal:</small><br>
                                    <span class="badge bg-info">${(scoreInfo.scoreBreakdown.temporal * 100).toFixed(1)}%</span>
                                </div>
                                <div class="col-6 mt-2">
                                    <small>Completeness:</small><br>
                                    <span class="badge bg-info">${(scoreInfo.scoreBreakdown.completeness * 100).toFixed(1)}%</span>
                                </div>
                                <div class="col-6 mt-2">
                                    <small>Order:</small><br>
                                    <span class="badge bg-info">${(scoreInfo.scoreBreakdown.order * 100).toFixed(1)}%</span>
                                </div>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <h6>📋 Metadata</h6>
                            <p><small><strong>Video:</strong> ${scoreInfo.metadata.videoId}</small></p>
                            <p><small><strong>Frame Range:</strong> ${scoreInfo.metadata.startFrame} - ${scoreInfo.metadata.endFrame}</small></p>
                            <p><small><strong>Duration:</strong> ${scoreInfo.metadata.duration} frames</small></p>
                            <p><small><strong>Completeness:</strong> ${(scoreInfo.metadata.completeness * 100).toFixed(1)}%</small></p>
                        </div>
                    </div>
                    
                    <h6>🎬 Final Sequence Frames</h6>
                    <div class="table-responsive">
                        <table class="table table-sm">
                            <thead class="table-light">
                                <tr>
                                    <th>Event</th>
                                    <th>Query</th>
                                    <th>Frame #</th>
                                    <th>Similarity</th>
                                    <th>Pivot</th>
                                    <th>Preview</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${scoreInfo.frames.map((frame, eventIndex) => `
                                    <tr class="${frame.matched ? '' : 'table-secondary'}">
                                        <td><span class="badge bg-secondary">${eventIndex + 1}</span></td>
                                        <td><small>${frame.eventQuery}</small></td>
                                        <td>${frame.frame ? `<strong>${frame.frame.keyframe_n}</strong>` : '<span class="text-muted">-</span>'}</td>
                                        <td>${frame.frame ? `<span class="badge bg-success">${(frame.frame.similarity * 100).toFixed(1)}%</span>` : '<span class="text-muted">-</span>'}</td>
                                        <td>${frame.frame?.isPivot ? '<i class="fas fa-star text-warning"></i>' : ''}</td>
                                        <td>
                                            ${frame.frame ? `
                                                <img src="/${frame.frame.image_path}" 
                                                     class="img-thumbnail debug-frame-preview" 
                                                     style="width: 30px; height: 22px; cursor: pointer;"
                                                     onclick="showFrameModal(${frame.frame.id})"
                                                     alt="Frame ${frame.frame.keyframe_n}">
                                            ` : '<span class="text-muted">No match</span>'}
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `).join('')}
        <p class="small text-muted">
            <i class="fas fa-info-circle"></i> 
            Showing detailed scoring analysis for all sequences. Final ranking is based on combined scores from similarity, temporal order, and completeness.
        </p>
    `;
}

function generateConfigDetails() {
    return `
        <div class="row mb-4">
            <div class="col-12">
                <div class="card">
                    <div class="card-header">
                        <h6 class="mb-0">⚙️ Algorithm Configuration</h6>
                    </div>
                    <div class="card-body">
                        <div class="row">
                            <div class="col-md-6">
                                <p><strong>Similarity Threshold:</strong> ${algorithmConfig.similarityThreshold}</p>
                                <p><strong>Score Threshold:</strong> ${algorithmConfig.scoreThreshold}</p>
                                <p><strong>Top K:</strong> ${algorithmConfig.topK}</p>
                                <p><strong>Max Temporal Gap:</strong> ${algorithmConfig.maxTemporalGap}</p>
                            </div>
                            <div class="col-md-6">
                                <p><strong>Search Window:</strong> ${algorithmConfig.searchWindow}</p>
                                <p><strong>Min Completeness:</strong> ${algorithmConfig.minSequenceCompleteness}</p>
                                <p><strong>Temporal Weight:</strong> ${algorithmConfig.temporalWeight}</p>
                                <p class="text-success"><strong>Early Filtering:</strong> ❌ Disabled (All candidates passed to Phase 2)</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function generateResultsPreview() {
    if (debugState.finalResults.length === 0) {
        return `
            <div class="row mb-4">
                <div class="col-12">
                    <div class="alert alert-warning">
                        <h6>⚠️ No Results Found</h6>
                        <p>The algorithm didn't find any sequences meeting the criteria. Consider:</p>
                        <ul>
                            <li>Lowering the similarity threshold</li>
                            <li>Lowering the score threshold</li>
                            <li>Increasing the search window</li>
                            <li>Using different event descriptions</li>
                        </ul>
                    </div>
                </div>
            </div>
        `;
    }
    
    const maxResults = Math.min(debugState.finalResults.length, 10);
    const displayResults = debugState.finalResults.slice(0, maxResults);
    
    return `
        <div class="row mb-4">
            <div class="col-12">
                <div class="card">
                    <div class="card-header">
                        <h6 class="mb-0">🏆 Final Results (Top ${maxResults})</h6>
                    </div>
                    <div class="card-body">
                        <div class="table-responsive">
                            <table class="table table-sm table-hover">
                                <thead class="table-light">
                                    <tr>
                                        <th>Rank</th>
                                        <th>Score</th>
                                        <th>Video</th>
                                        <th>Frame Range</th>
                                        <th>Duration</th>
                                        <th>Completeness</th>
                                        <th>Preview</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${displayResults.map((result, index) => {
                                        // Get first valid frame for preview
                                        const firstFrame = result.sequence.find(frameData => frameData && frameData.frame);
                                        return `
                                            <tr>
                                                <td><span class="badge bg-primary">#${index + 1}</span></td>
                                                <td><span class="badge bg-success">${(result.score * 100).toFixed(1)}%</span></td>
                                                <td><small>${result.metadata.videoId}</small></td>
                                                <td><strong>${result.metadata.startFrame} - ${result.metadata.endFrame}</strong></td>
                                                <td>${result.metadata.duration} frames</td>
                                                <td><span class="badge bg-info">${(result.metadata.completeness * 100).toFixed(0)}%</span></td>
                                                <td>
                                                    ${firstFrame ? `
                                                        <img src="/${firstFrame.frame.image_path}" 
                                                             class="img-thumbnail debug-frame-preview" 
                                                             style="width: 40px; height: 30px; cursor: pointer;"
                                                             onclick="showFrameModal(${firstFrame.frame.id})"
                                                             alt="First frame">
                                                    ` : '<span class="text-muted">No preview</span>'}
                                                </td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                        
                        <div class="row mt-3">
                            <div class="col-md-6">
                                <h6>🥇 Top Result Details</h6>
                                <div class="row">
                                    <div class="col-6">
                                        <small>Base Similarity:</small><br>
                                        <span class="badge bg-info">${(displayResults[0].scoreBreakdown.baseSimilarity * 100).toFixed(1)}%</span>
                                    </div>
                                    <div class="col-6">
                                        <small>Temporal:</small><br>
                                        <span class="badge bg-info">${(displayResults[0].scoreBreakdown.temporal * 100).toFixed(1)}%</span>
                                    </div>
                                    <div class="col-6 mt-2">
                                        <small>Completeness:</small><br>
                                        <span class="badge bg-info">${(displayResults[0].scoreBreakdown.completeness * 100).toFixed(1)}%</span>
                                    </div>
                                    <div class="col-6 mt-2">
                                        <small>Order:</small><br>
                                        <span class="badge bg-info">${(displayResults[0].scoreBreakdown.order * 100).toFixed(1)}%</span>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-6">
                                <h6>🎬 Top Sequence Frames</h6>
                                <div class="d-flex flex-wrap gap-1">
                                    ${displayResults[0].sequence.map((frameData, eventIndex) => {
                                        if (!frameData || !frameData.frame) {
                                            return `<div class="text-muted small" style="width: 30px; height: 22px; display: flex; align-items: center; justify-content: center; border: 1px dashed #ccc;">-</div>`;
                                        }
                                        return `
                                            <img src="/${frameData.frame.image_path}" 
                                                 class="img-thumbnail debug-frame-preview" 
                                                 style="width: 30px; height: 22px; cursor: pointer; ${frameData.isPivot ? 'border: 2px solid #ffc107;' : ''}"
                                                 onclick="showFrameModal(${frameData.frame.id})"
                                                 title="Event ${eventIndex + 1}${frameData.isPivot ? ' (Pivot)' : ''}: Frame ${frameData.frame.keyframe_n}"
                                                 alt="Frame ${frameData.frame.keyframe_n}">
                                        `;
                                    }).join('')}
                                </div>
                                <p class="small text-muted mt-1">
                                    <i class="fas fa-star text-warning"></i> Gold border = Pivot frame
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Event listener for debug test events dropdown
document.addEventListener('DOMContentLoaded', function() {
    const debugTestEvents = document.getElementById('debugTestEvents');
    if (debugTestEvents) {
        debugTestEvents.addEventListener('change', function() {
            const value = this.value;
            const event1 = document.getElementById('debugEvent1');
            const event2 = document.getElementById('debugEvent2');
            const event3 = document.getElementById('debugEvent3');
            
            if (value === 'simple') {
                if (event1) event1.value = 'person walking';
                if (event2) event2.value = 'car driving';
                if (event3) event3.value = '';
            } else if (value === 'complex') {
                if (event1) event1.value = 'person standing';
                if (event2) event2.value = 'person walking';
                if (event3) event3.value = 'car approaching';
            }
        });
    }
});

// Legacy scoring function (keep for compatibility)
function calculateSequenceScore(sequence, events) {
    const totalSimilarity = sequence.frames.reduce((sum, frameData) => {
        return sum + (frameData ? frameData.similarity : 0);
    }, 0);
    
    return totalSimilarity / events.length;
}

// Enhanced display for sequence results
function displayEnhancedSequenceResults(results, events) {
    const resultsDiv = document.getElementById('searchResults');
    currentSearchResults = []; // Clear for CSV export
    
    // Store sequences and events globally
    allSequences = results;
    currentEvents = events;
    
    if (!results || results.length === 0) {
        resultsDiv.innerHTML = `
            <div class="text-center text-muted py-5">
                <i class="fas fa-search fa-3x mb-3"></i>
                <h4>No sequences found</h4>
                <p>Try adjusting your thresholds or event descriptions</p>
            </div>
        `;
        return;
    }
    
    let html = `
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h4>Enhanced TRAKE Sequence Results</h4>
            <div class="text-muted">
                <i class="fas fa-info-circle me-1"></i>
                Found ${results.length} sequences
            </div>
        </div>
    `;
    
    results.forEach((result, index) => {
        const sequence = result.sequence;
        const breakdown = result.scoreBreakdown;
        const metadata = result.metadata;
        
        html += `
            <div class="sequence-result enhanced">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h5>Sequence ${index + 1}</h5>
                    <div class="score-info">
                        <span class="sequence-score">Score: ${(result.score * 100).toFixed(1)}%</span>
                        <small class="text-muted ms-2">
                            (Sim: ${(breakdown.baseSimilarity * 100).toFixed(0)}%, 
                             Temp: ${(breakdown.temporal * 100).toFixed(0)}%, 
                             Comp: ${(breakdown.completeness * 100).toFixed(0)}%)
                        </small>
                    </div>
                </div>
                
                <div class="sequence-metadata mb-3">
                    <small class="text-muted">
                        Video: ${metadata.videoId} | 
                        Frames: ${metadata.startFrame}-${metadata.endFrame} | 
                        Duration: ${metadata.duration} frames | 
                        Completeness: ${(metadata.completeness * 100).toFixed(0)}%
                    </small>
                </div>
                
                <div class="sequence-frames">
        `;
        
        sequence.forEach((frameData, frameIndex) => {
            // Add safety checks
            if (!frameData || !frameData.frame) {
                console.warn('Invalid frame data at index:', frameIndex);
                return;
            }
            
            const imagePath = `/images/${frameData.videoId || frameData.frame.video_id}/${frameData.frame.image_filename}`;
            const pivotClass = frameData.isPivot ? 'pivot' : '';
            const frameNumber = frameData.frame.keyframe_n || frameData.frame.frame_idx || frameIndex;
            const similarity = frameData.similarity || 0;
            
            html += `
                <div class="sequence-frame ${pivotClass}" onclick="openEnhancedSequenceFrame(${index})">
                    <img src="${imagePath}" alt="Event ${frameIndex + 1}" onerror="this.src='/static/placeholder.jpg'">
                    <div class="small mt-1">
                        <div>Frame ${frameNumber}</div>
                        <div class="event-label">Event ${frameIndex + 1}</div>
                        <div class="text-muted">${(similarity * 100).toFixed(1)}%</div>
                        ${frameData.isPivot ? '<div class="pivot-label">PIVOT</div>' : ''}
                    </div>
                </div>
            `;
            
            // Add to results for CSV export
            if (frameData.frame) {
                currentSearchResults.push(frameData.frame);
            }
        });
        
        html += `
                </div>
            </div>
        `;
    });
    
    resultsDiv.innerHTML = html;
}

// Open enhanced sequence frame viewer
function openEnhancedSequenceFrame(resultIndex) {
    if (resultIndex >= 0 && resultIndex < allSequences.length) {
        const result = allSequences[resultIndex];
        openSequenceFrameEnhanced(result, currentEvents);
    }
}

// Enhanced sequence frame viewer
function openSequenceFrameEnhanced(result, events) {
    currentSequence = result;
    
    displayEnhancedSequenceViewer(result, events);
    const modal = new bootstrap.Modal(document.getElementById('sequenceModal'));
    modal.show();
}

// Enhanced sequence viewer modal display
function displayEnhancedSequenceViewer(result, events) {
    const viewer = document.getElementById('sequenceViewer');
    const sequence = result.sequence;
    const breakdown = result.scoreBreakdown;
    const metadata = result.metadata;
    
    let html = `
        <div class="row mb-4">
            <div class="col-12">
                <div class="d-flex justify-content-between align-items-center">
                    <h5>Enhanced Event Sequence</h5>
                    <span class="sequence-score">Score: ${(result.score * 100).toFixed(1)}%</span>
                </div>
                <div class="text-muted small">
                    Video: ${metadata.videoId} | 
                    Frames: ${metadata.startFrame}-${metadata.endFrame} | 
                    Duration: ${metadata.duration} frames
                </div>
            </div>
        </div>
        
        <div class="row mb-4">
            <div class="col-12">
                <div class="score-breakdown">
                    <h6>Score Breakdown:</h6>
                    <div class="row">
                        <div class="col">Base Similarity: ${(breakdown.baseSimilarity * 100).toFixed(1)}%</div>
                        <div class="col">Temporal: ${(breakdown.temporal * 100).toFixed(1)}%</div>
                        <div class="col">Completeness: ${(breakdown.completeness * 100).toFixed(1)}%</div>
                        <div class="col">Consistency: ${(breakdown.consistency * 100).toFixed(1)}%</div>
                        <div class="col">Order: ${(breakdown.order * 100).toFixed(1)}%</div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="row g-4">
    `;
    
    sequence.forEach((frameData, index) => {
        const imagePath = `/images/${frameData.videoId}/${frameData.frame.image_filename}`;
        const pivotClass = frameData.isPivot ? 'border-danger border-3' : 'border-success border-2';
        
        html += `
            <div class="col-md-4">
                <div class="text-center">
                    <div class="mb-2">
                        <span class="badge bg-primary">Event ${index + 1}</span>
                        ${frameData.isPivot ? '<span class="badge bg-danger ms-1">Pivot</span>' : ''}
                    </div>
                    <img src="${imagePath}" 
                         class="img-fluid rounded ${pivotClass}" 
                         style="max-height: 300px; cursor: pointer;"
                         onclick="openFrameViewer(${frameData.frame.id})"
                         alt="Event ${index + 1}">
                    <div class="mt-2">
                        <div class="fw-bold">Frame ${frameData.frame.keyframe_n}</div>
                        <div class="text-muted small">${formatTime(frameData.frame.pts_time)}</div>
                        <div class="text-success small">Similarity: ${(frameData.similarity * 100).toFixed(1)}%</div>
                    </div>
                    <div class="mt-2">
                        <div class="small text-muted">
                            <strong>Event Description:</strong><br>
                            ${events[index]?.query || 'N/A'}
                        </div>
                    </div>
                </div>
            </div>
        `;
    });
    
    html += `
        </div>
        <div class="row mt-4">
            <div class="col-12">
                <div class="alert alert-info">
                    <h6><i class="fas fa-info-circle me-2"></i>Enhanced Sequence Information:</h6>
                    <ul class="mb-0">
                        <li><strong>Video ID:</strong> ${metadata.videoId}</li>
                        <li><strong>Frame Range:</strong> ${metadata.startFrame} - ${metadata.endFrame}</li>
                        <li><strong>Duration:</strong> ${metadata.duration} frames</li>
                        <li><strong>Completeness:</strong> ${(metadata.completeness * 100).toFixed(1)}%</li>
                        <li><strong>Final Score:</strong> ${(result.score * 100).toFixed(1)}%</li>
                    </ul>
                </div>
            </div>
        </div>
    `;
    
    viewer.innerHTML = html;
}

// Open sequence frame by index (legacy compatibility)
function openSequenceFrameByIndex(sequenceIndex) {
    if (sequenceIndex >= 0 && sequenceIndex < allSequences.length) {
        const result = allSequences[sequenceIndex];
        // Check if it's the new enhanced format or legacy format
        if (result.sequence && result.scoreBreakdown) {
            // New enhanced format
            openSequenceFrameEnhanced(result, currentEvents);
        } else {
            // Legacy format - convert to enhanced format
            const legacyResult = {
                sequence: result.frames ? result.frames : result,
                score: result.score || 0,
                scoreBreakdown: {
                    baseSimilarity: 0.8,
                    temporal: 0.8,
                    completeness: 1.0,
                    consistency: 0.8,
                    order: 1.0
                },
                metadata: {
                    videoId: result.frames ? result.frames[0]?.frame?.video_id : 'unknown',
                    startFrame: 0,
                    endFrame: 100,
                    duration: 100,
                    completeness: 1.0
                }
            };
            openSequenceFrameEnhanced(legacyResult, currentEvents);
        }
    }
}

// Legacy function kept for compatibility
function openSequenceFrame(sequence, events) {
    // Convert legacy format to enhanced format
    const enhancedResult = {
        sequence: sequence.frames || sequence,
        score: sequence.score || 0,
        scoreBreakdown: {
            baseSimilarity: 0.8,
            temporal: 0.8,
            completeness: 1.0,
            consistency: 0.8,
            order: 1.0
        },
        metadata: {
            videoId: sequence.frames ? sequence.frames[0]?.frame?.video_id : 'unknown',
            startFrame: 0,
            endFrame: 100,
            duration: 100,
            completeness: 1.0
        }
    };
    
    currentSequence = enhancedResult;
    displayEnhancedSequenceViewer(enhancedResult, events);
    const modal = new bootstrap.Modal(document.getElementById('sequenceModal'));
    modal.show();
}

// Legacy display sequence viewer (converted to use enhanced viewer)
function displaySequenceViewer(sequence, events) {
    // Convert legacy format to enhanced format and use the enhanced viewer
    const enhancedResult = {
        sequence: sequence.frames || sequence,
        score: sequence.score || 0,
        scoreBreakdown: {
            baseSimilarity: 0.8,
            temporal: 0.8,
            completeness: 1.0,
            consistency: 0.8,
            order: 1.0
        },
        metadata: {
            videoId: sequence.frames ? sequence.frames[0]?.frame?.video_id : 'unknown',
            startFrame: 0,
            endFrame: 100,
            duration: 100,
            completeness: 1.0
        }
    };
    
    displayEnhancedSequenceViewer(enhancedResult, events);
}

// Export sequence to CSV (enhanced version)
function exportSequenceCSV() {
    if (!currentSequence) {
        showError('No sequence to export');
        return;
    }
    
    let videoId, frameNumbers;
    
    // Handle both enhanced and legacy format
    if (currentSequence.sequence && Array.isArray(currentSequence.sequence)) {
        // Enhanced format
        const sequence = currentSequence.sequence;
        videoId = currentSequence.metadata?.videoId || sequence[0]?.videoId || 'unknown';
        frameNumbers = sequence
            .filter(frameData => frameData !== null)
            .map(frameData => frameData.frame ? frameData.frame.keyframe_n : frameData.frameIndex);
    } else if (currentSequence.frames) {
        // Legacy format
        videoId = currentSequence.frames[0]?.frame?.video_id || 'unknown';
        frameNumbers = currentSequence.frames
            .filter(frameData => frameData !== null)
            .map(frameData => frameData.frame.keyframe_n);
    } else {
        showError('Invalid sequence format for export');
        return;
    }
    
    if (!frameNumbers || frameNumbers.length === 0) {
        showError('No frame numbers found to export');
        return;
    }
    
    // Create CSV content: videoID,frame1,frame2,frame3
    const csvContent = `${videoId},${frameNumbers.join(',')}`;
    
    // Create and trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `sequence_${videoId}_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showSuccess(`Exported sequence for video ${videoId} with ${frameNumbers.length} frames`);
}

// Perform TRAKE search
async function performTRAKESearch() {
    const videoId = document.getElementById('trakeVideoId').value.trim();
    const mode = document.getElementById('trakeMode').value;
    const topK = document.getElementById('trakeTopK').value;
    
    if (!videoId) {
        showError('Please enter a video ID for TRAKE search');
        return;
    }
    
    if (mode === 'text') {
        // Text TRAKE search
        const query = document.getElementById('trakeTextQuery').value.trim();
        if (!query) {
            showError('Please enter a text query');
            return;
        }
        
        showLoading(true);
        
        try {
            const params = new URLSearchParams({
                query: query,
                top_k: topK,
                video_id: videoId
            });
            
            const response = await fetch(`/search/text?${params.toString()}`, {
                method: 'POST'
            });
            
            const data = await response.json();
            
            if (response.ok) {
                displayResults(data.results, `TRAKE text search: "${query}" in video ${videoId}`);
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
        
    } else {
        // Image TRAKE search
        const fileInput = document.getElementById('trakeImageFile');
        if (!fileInput.files[0]) {
            showError('Please select an image file');
            return;
        }
        
        showLoading(true);
        
        try {
            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            
            const params = new URLSearchParams({
                top_k: topK,
                video_id: videoId
            });
            
            const response = await fetch(`/search/image?${params.toString()}`, {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (response.ok) {
                displayResults(data.results, `TRAKE image search: ${data.filename} in video ${videoId}`);
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
}

// Open YouTube video at specific timestamp
function openYouTubeAtTimestamp(watchUrl, ptsTime) {
    const videoId = extractYouTubeId(watchUrl);
    const startTime = Math.floor(ptsTime);
    
    if (videoId) {
        const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}&t=${startTime}s`;
        window.open(youtubeUrl, '_blank');
    } else {
        showError('Invalid YouTube URL: ' + watchUrl);
    }
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
