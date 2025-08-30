// Image preview helper function
function previewImage(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('imagePreview').innerHTML = 
            `<img src="${e.target.result}" alt="Preview" class="img-thumbnail">`;
    };
    reader.readAsDataURL(file);
}

// Setup drag and drop functionality for image search
function setupImageDragAndDrop() {
    const dropZone = document.getElementById('imageDropZone');
    
    if (!dropZone) {
        // Fallback: create a simple drop zone if element doesn't exist
        const imageSearchTab = document.getElementById('image-search');
        if (imageSearchTab) {
            const fallbackDropZone = document.createElement('div');
            fallbackDropZone.id = 'imageDropZone';
            fallbackDropZone.className = 'image-drop-zone mt-2';
            fallbackDropZone.innerHTML = `
                <div class="drop-zone-content">
                    <i class="fas fa-cloud-upload-alt fa-2x mb-2"></i>
                    <p class="mb-1"><strong>Drag & drop images here</strong></p>
                    <p class="small text-muted mb-1">or press <kbd>Ctrl+V</kbd> to paste from clipboard</p>
                    <p class="small text-muted">Supports: JPG, PNG, GIF</p>
                </div>
            `;
            
            const fileInput = document.getElementById('imageFile');
            if (fileInput && fileInput.parentNode) {
                fileInput.parentNode.insertBefore(fallbackDropZone, fileInput.nextSibling);
            }
        }
    }
    
    const finalDropZone = document.getElementById('imageDropZone');
    if (!finalDropZone) return;
    
    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        finalDropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });
    
    // Highlight drop zone when item is dragged over it
    ['dragenter', 'dragover'].forEach(eventName => {
        finalDropZone.addEventListener(eventName, highlight, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        finalDropZone.addEventListener(eventName, unhighlight, false);
    });
    
    // Handle dropped files
    finalDropZone.addEventListener('drop', handleDrop, false);
    
    // Make drop zone clickable to trigger file input
    finalDropZone.addEventListener('click', function() {
        document.getElementById('imageFile').click();
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    function highlight(e) {
        finalDropZone.classList.add('drag-over');
    }
    
    function unhighlight(e) {
        finalDropZone.classList.remove('drag-over');
    }
    
    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        
        if (files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
                // Set the file to the input element
                const fileInput = document.getElementById('imageFile');
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                fileInput.files = dataTransfer.files;
                
                // Preview the image
                previewImage(file);
                
                showSuccess(`Image "${file.name}" loaded successfully`);
            } else {
                showError('Please drop only image files (JPG, PNG, GIF)');
            }
        }
    }
}

// Setup clipboard paste functionality
function setupClipboardPaste() {
    document.addEventListener('keydown', function(e) {
        // Check if we're in the image search tab
        const imageTab = document.getElementById('image-tab');
        const isImageTabActive = imageTab && imageTab.classList.contains('active');
        
        if (e.ctrlKey && e.key === 'v' && isImageTabActive) {
            // Small delay to ensure clipboard paste event fires
            setTimeout(handleClipboardPaste, 100);
        }
    });
    
    document.addEventListener('paste', function(e) {
        // Check if we're in the image search tab
        const imageTab = document.getElementById('image-tab');
        const isImageTabActive = imageTab && imageTab.classList.contains('active');
        
        if (isImageTabActive) {
            handleClipboardPaste(e);
        }
    });
    
    function handleClipboardPaste(e) {
        if (e && e.clipboardData) {
            const items = e.clipboardData.items;
            
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    
                    const file = item.getAsFile();
                    if (file) {
                        // Set the file to the input element
                        const fileInput = document.getElementById('imageFile');
                        const dataTransfer = new DataTransfer();
                        dataTransfer.items.add(file);
                        fileInput.files = dataTransfer.files;
                        
                        // Preview the image
                        previewImage(file);
                        
                        showSuccess('Image pasted from clipboard successfully');
                        return;
                    }
                }
            }
        }
    }
}

// Setup drag and drop reordering for results
function setupResultsReordering() {
    const resultsContainer = document.getElementById('searchResults');
    if (!resultsContainer) return;
    
    // Add sortable class to results container
    const resultsGrid = resultsContainer.querySelector('.row');
    if (resultsGrid) {
        resultsGrid.classList.add('sortable-results');
        
        // Add drag and drop handlers to result cards
        const resultCards = resultsGrid.querySelectorAll('.result-card');
        resultCards.forEach((card, index) => {
            card.draggable = true;
            card.dataset.originalIndex = index;
            
            card.addEventListener('dragstart', function(e) {
                this.classList.add('dragging');
                e.dataTransfer.setData('text/plain', index);
            });
            
            card.addEventListener('dragend', function(e) {
                this.classList.remove('dragging');
            });
            
            card.addEventListener('dragover', function(e) {
                e.preventDefault();
            });
            
            card.addEventListener('drop', function(e) {
                e.preventDefault();
                const dragIndex = parseInt(e.dataTransfer.getData('text/plain'));
                const dropIndex = parseInt(this.dataset.originalIndex);
                
                if (dragIndex !== dropIndex) {
                    reorderResults(dragIndex, dropIndex);
                }
            });
        });
    }
}

// Reorder search results
function reorderResults(fromIndex, toIndex) {
    if (!currentSearchResults || currentSearchResults.length === 0) return;
    
    // Move the item in the array
    const movedItem = currentSearchResults.splice(fromIndex, 1)[0];
    currentSearchResults.splice(toIndex, 0, movedItem);
    
    // Re-display the results with new order
    const lastSearchInfo = document.querySelector('#searchResults .text-muted')?.textContent || 'Reordered results';
    displayResults(currentSearchResults, lastSearchInfo);
    
    // Re-setup reordering for the new DOM elements
    setupResultsReordering();
    
    showSuccess('Results reordered successfully');
}

// Update the image file change handler
document.addEventListener('DOMContentLoaded', function() {
    // Replace original image file handler with new one
    const imageFile = document.getElementById('imageFile');
    if (imageFile) {
        // Remove existing event listeners by cloning the node
        const newImageFile = imageFile.cloneNode(true);
        imageFile.parentNode.replaceChild(newImageFile, imageFile);
        
        // Add new event listener
        newImageFile.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                previewImage(file);
            }
        });
    }
    
    // Setup new functionalities
    setTimeout(() => {
        setupImageDragAndDrop();
        setupClipboardPaste();
    }, 1000);
});
// Hook into the original displayResults function
function hookDisplayResults() {
    if (typeof window.displayResults === 'function') {
        const originalDisplayResults = window.displayResults;
        
        window.displayResults = function(results, searchInfo) {
            // Call original function
            originalDisplayResults(results, searchInfo);
            
            // Add reordering functionality after results are displayed
            setTimeout(() => {
                setupResultsReordering();
            }, 100);
        };
    }
}

// Initialize hook
setTimeout(() => {
    hookDisplayResults();
}, 2000);
