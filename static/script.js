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

// Initialize TRAKE events with 3 default rows
function initializeTRAKEEvents() {
    console.log('Initializing TRAKE events...');
    const container = document.getElementById('eventsContainer');
    
    if (!container) {
        console.error('eventsContainer not found!');
        return;
    }
    
    container.innerHTML = '';
    nextEventNumber = 1;
    
    // Add 3 default event rows
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
        
        if (eventRows.length <= 3) {
            // Hide all remove buttons if we have 3 or fewer events
            if (removeBtn) removeBtn.style.display = 'none';
        } else {
            // Show remove buttons if we have more than 3 events
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

// Perform TRAKE Sequence Search
async function performTRAKESequenceSearch() {
    const topK = document.getElementById('trakeTopK').value;
    const similarityThreshold = parseFloat(document.getElementById('similarityThreshold').value);
    const scoreThreshold = parseFloat(document.getElementById('scoreThreshold').value);
    const events = getEventsData();
    
    if (events.length < 3) {
        showError('Please enter descriptions for at least 3 events');
        return;
    }
    
    showLoading(true);
    
    try {
        // Step 1: Merge all queries into one combined query
        const mergedQuery = events.map(event => event.query).join('. ');
        console.log('Merged query:', mergedQuery);
        
        // Step 2: Get initial search results from entire database
        const params = new URLSearchParams({
            query: mergedQuery,
            top_k: topK
            // No video_id - search across entire database
        });
        
        const response = await fetch(`/search/text?${params.toString()}`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.detail || 'Search failed');
        }
        
        // Step 3: Process results to find event sequences
        const sequences = await findEventSequences(data.results, events, similarityThreshold, scoreThreshold);
        
        // Step 4: Display sequence results
        displaySequenceResults(sequences, events);
        
    } catch (error) {
        console.error('Error in TRAKE sequence search:', error);
        showError('TRAKE sequence search failed: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// Find event sequences in search results
async function findEventSequences(searchResults, events, similarityThreshold, scoreThreshold) {
    const sequences = [];
    
    for (const result of searchResults) {
        // Find best matching event for this frame (pivot)
        const pivotEvent = await findBestMatchingEvent(result, events);
        
        if (pivotEvent.similarity < similarityThreshold) {
            continue; // Skip if pivot doesn't meet similarity threshold
        }
        
        // Build sequence around pivot
        const sequence = await buildSequenceAroundPivot(result, pivotEvent, events, similarityThreshold);
        
        if (sequence && sequence.frames.length === events.length) {
            // Calculate final score with new algorithm
            const finalScore = calculateNewSequenceScore(sequence, events);
            
            if (finalScore >= scoreThreshold) {
                sequence.score = finalScore;
                sequences.push(sequence);
            }
        }
    }
    
    // Sort sequences by score
    sequences.sort((a, b) => b.score - a.score);
    
    return sequences;
}

// Find best matching event for a frame
async function findBestMatchingEvent(frame, events) {
    let bestMatch = { eventIndex: 0, similarity: 0 };
    
    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        
        // Use text search to get similarity between frame and event
        // This is a simplified approach - in reality you'd use embeddings
        const similarity = await calculateFrameEventSimilarity(frame, event.query);
        
        if (similarity > bestMatch.similarity) {
            bestMatch = { eventIndex: i, similarity: similarity * event.weight };
        }
    }
    
    return bestMatch;
}

// Calculate similarity between frame and event (simplified)
async function calculateFrameEventSimilarity(frame, eventQuery) {
    // This is a placeholder - in a real implementation you would:
    // 1. Get frame embedding using the frame image
    // 2. Get event embedding using the event text
    // 3. Calculate cosine similarity between embeddings
    // For now, we'll use the frame's existing similarity score as approximation
    return Math.min(frame.similarity + (Math.random() - 0.5) * 0.2, 1.0);
}

// Build sequence around pivot frame
async function buildSequenceAroundPivot(pivotFrame, pivotEvent, events, similarityThreshold) {
    const sequence = {
        pivotFrame: pivotFrame,
        pivotEventIndex: pivotEvent.eventIndex,
        frames: new Array(events.length).fill(null)
    };
    
    // Place pivot frame
    sequence.frames[pivotEvent.eventIndex] = {
        frame: pivotFrame,
        eventIndex: pivotEvent.eventIndex,
        similarity: pivotEvent.similarity,
        isPivot: true
    };
    
    // Get all frames from the same video as pivot
    const videoFrames = await getVideoFrames(pivotFrame.video_id);
    
    // Find frames for events before pivot
    for (let i = pivotEvent.eventIndex - 1; i >= 0; i--) {
        const targetFrame = await findBestFrameForEvent(
            videoFrames,
            events[i],
            pivotFrame.frame_idx,
            'before',
            similarityThreshold
        );
        
        if (targetFrame) {
            sequence.frames[i] = {
                frame: targetFrame,
                eventIndex: i,
                similarity: targetFrame.similarity,
                isPivot: false
            };
        } else {
            return null; // Sequence incomplete
        }
    }
    
    // Find frames for events after pivot
    for (let i = pivotEvent.eventIndex + 1; i < events.length; i++) {
        const targetFrame = await findBestFrameForEvent(
            videoFrames,
            events[i],
            pivotFrame.frame_idx,
            'after',
            similarityThreshold
        );
        
        if (targetFrame) {
            sequence.frames[i] = {
                frame: targetFrame,
                eventIndex: i,
                similarity: targetFrame.similarity,
                isPivot: false
            };
        } else {
            return null; // Sequence incomplete
        }
    }
    
    return sequence;
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

// Calculate final score for sequence with new algorithm
function calculateNewSequenceScore(sequence, events) {
    // Step 1: Get all similarities from frames
    const similarities = sequence.frames
        .filter(frameData => frameData !== null)
        .map(frameData => frameData.similarity);
    
    if (similarities.length === 0) return 0;
    
    // Step 2: Calculate average similarity
    const averageSimilarity = similarities.reduce((sum, sim) => sum + sim, 0) / similarities.length;
    
    // Step 3: Compare each similarity with average, +1 if higher, +0 if lower
    let totalPoints = 0;
    for (const similarity of similarities) {
        if (similarity > averageSimilarity) {
            totalPoints += 1;
        }
        // If similarity <= averageSimilarity, add 0 (no points)
    }
    
    // Step 4: Final score = total points / number of events
    const finalScore = totalPoints / events.length;
    
    return finalScore;
}

// Legacy scoring function (keep for compatibility)
function calculateSequenceScore(sequence, events) {
    const totalSimilarity = sequence.frames.reduce((sum, frameData) => {
        return sum + (frameData ? frameData.similarity : 0);
    }, 0);
    
    return totalSimilarity / events.length;
}

// Display sequence search results
function displaySequenceResults(sequences, events) {
    const resultsDiv = document.getElementById('searchResults');
    currentSearchResults = []; // Clear for CSV export
    
    // Store sequences and events globally
    allSequences = sequences;
    currentEvents = events;
    
    if (!sequences || sequences.length === 0) {
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
            <h4>TRAKE Sequence Results</h4>
            <div class="text-muted">
                <i class="fas fa-info-circle me-1"></i>
                Found ${sequences.length} sequences
            </div>
        </div>
    `;
    
    sequences.forEach((sequence, index) => {
        html += `
            <div class="sequence-result">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h5>Sequence ${index + 1}</h5>
                    <span class="sequence-score">Score: ${(sequence.score * 100).toFixed(1)}%</span>
                </div>
                <div class="sequence-frames">
        `;
        
        sequence.frames.forEach((frameData, eventIndex) => {
            if (frameData) {
                const imagePath = `/images/${frameData.frame.video_id}/${frameData.frame.image_filename}`;
                const pivotClass = frameData.isPivot ? 'pivot' : '';
                
                html += `
                    <div class="sequence-frame ${pivotClass}" onclick="openSequenceFrameByIndex(${index})">
                        <img src="${imagePath}" alt="Event ${eventIndex + 1}">
                        <div class="small mt-1">
                            <div>Frame ${frameData.frame.keyframe_n}</div>
                            <div class="event-label">Event ${eventIndex + 1}</div>
                            <div class="text-muted">${(frameData.similarity * 100).toFixed(1)}%</div>
                        </div>
                    </div>
                `;
                
                // Add to results for CSV export
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

// Open sequence frame by index
function openSequenceFrameByIndex(sequenceIndex) {
    if (sequenceIndex >= 0 && sequenceIndex < allSequences.length) {
        const sequence = allSequences[sequenceIndex];
        openSequenceFrame(sequence, currentEvents);
    }
}

// Open sequence frame in new sequence viewer
function openSequenceFrame(sequence, events) {
    currentSequence = sequence;
    
    displaySequenceViewer(sequence, events);
    const modal = new bootstrap.Modal(document.getElementById('sequenceModal'));
    modal.show();
}

// Display sequence viewer modal
function displaySequenceViewer(sequence, events) {
    const viewer = document.getElementById('sequenceViewer');
    
    let html = `
        <div class="row mb-4">
            <div class="col-12">
                <div class="d-flex justify-content-between align-items-center">
                    <h5>Event Sequence</h5>
                    <span class="sequence-score">Score: ${(sequence.score * 100).toFixed(1)}%</span>
                </div>
                <div class="text-muted small">Video: ${sequence.frames[0]?.frame.video_id}</div>
            </div>
        </div>
        
        <div class="row g-4">
    `;
    
    sequence.frames.forEach((frameData, index) => {
        if (frameData) {
            const imagePath = `/images/${frameData.frame.video_id}/${frameData.frame.image_filename}`;
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
        }
    });
    
    html += `
        </div>
        <div class="row mt-4">
            <div class="col-12">
                <div class="alert alert-info">
                    <h6><i class="fas fa-info-circle me-2"></i>Sequence Information:</h6>
                    <ul class="mb-0">
                        <li><strong>Video ID:</strong> ${sequence.frames[0]?.frame.video_id}</li>
                        <li><strong>Frame Range:</strong> ${Math.min(...sequence.frames.map(f => f?.frame.keyframe_n || 0))} - ${Math.max(...sequence.frames.map(f => f?.frame.keyframe_n || 0))}</li>
                        <li><strong>Pivot Event:</strong> Event ${sequence.pivotEventIndex + 1}</li>
                        <li><strong>Final Score:</strong> ${(sequence.score * 100).toFixed(1)}%</li>
                    </ul>
                </div>
            </div>
        </div>
    `;
    
    viewer.innerHTML = html;
}

// Export sequence to CSV
function exportSequenceCSV() {
    if (!currentSequence) {
        showError('No sequence to export');
        return;
    }
    
    // Get video ID and frame numbers
    const videoId = currentSequence.frames[0]?.frame.video_id;
    const frameNumbers = currentSequence.frames
        .filter(frameData => frameData !== null)
        .map(frameData => frameData.frame.keyframe_n);
    
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
    
    showSuccess(`Exported sequence for video ${videoId}`);
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