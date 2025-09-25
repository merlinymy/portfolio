import { galleryArr } from '../assets/galleryArr.js';

/**
 * Gallery class handles the dynamic rendering and lightbox functionality
 * Modular design allows for easy extension with filters, search, etc.
 */
class Gallery {
  constructor() {
    this.images = galleryArr;
    this.currentImageIndex = 0;
    this.lightboxOpen = false;

    this.galleryGrid = document.getElementById('gallery-grid');
    this.lightbox = document.getElementById('lightbox');
    this.lightboxImage = document.getElementById('lightbox-image');
    this.lightboxTitle = document.getElementById('lightbox-title');

    this.init();
  }

  init() {
    this.renderGallery();
    this.setupLightboxEvents();
    this.setupKeyboardEvents();
  }

  /**
   * Renders the gallery grid dynamically from galleryArr
   * Creates gallery items with proper accessibility attributes
   */
  renderGallery() {
    if (!this.galleryGrid) {
      console.error('Gallery grid element not found');
      return;
    }

    this.galleryGrid.innerHTML = '';

    this.images.forEach((image, index) => {
      const galleryItem = this.createGalleryItem(image, index);
      this.galleryGrid.appendChild(galleryItem);
    });
  }

  /**
   * Creates a single gallery item element
   * @param {Object} image - Image object with url, name, and alt properties
   * @param {number} index - Index of the image in the array
   * @returns {HTMLElement} Gallery item element
   */
  createGalleryItem(image, index) {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `View image: ${image.name}`);

    // Create image container to maintain aspect ratio
    const imageContainer = document.createElement('div');
    imageContainer.className = 'gallery-item-image-container';

    const img = document.createElement('img');
    img.src = image.url;
    img.alt = image.alt;
    img.className = 'gallery-item-image';
    img.loading = 'lazy'; // Performance optimization

    const info = document.createElement('div');
    info.className = 'gallery-item-info';

    const title = document.createElement('h3');
    title.className = 'gallery-item-title';
    title.textContent = image.name;

    imageContainer.appendChild(img);
    info.appendChild(title);
    item.appendChild(imageContainer);
    item.appendChild(info);

    // Add click and keyboard event listeners
    item.addEventListener('click', () => this.openLightbox(index));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.openLightbox(index);
      }
    });

    return item;
  }

  /**
   * Sets up lightbox event listeners
   */
  setupLightboxEvents() {
    const closeBtn = document.querySelector('.lightbox-close');
    const prevBtn = document.querySelector('.lightbox-prev');
    const nextBtn = document.querySelector('.lightbox-next');
    const backdrop = document.querySelector('.lightbox-backdrop');

    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closeLightbox());
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.showPreviousImage());
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.showNextImage());
    }

    if (backdrop) {
      backdrop.addEventListener('click', () => this.closeLightbox());
    }
  }

  /**
   * Sets up keyboard navigation for lightbox
   */
  setupKeyboardEvents() {
    document.addEventListener('keydown', (e) => {
      if (!this.lightboxOpen) return;

      switch (e.key) {
        case 'Escape':
          this.closeLightbox();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.showPreviousImage();
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.showNextImage();
          break;
      }
    });
  }

  /**
   * Opens the lightbox with the specified image
   * @param {number} index - Index of the image to display
   */
  openLightbox(index) {
    if (index < 0 || index >= this.images.length) return;

    this.currentImageIndex = index;
    this.lightboxOpen = true;

    const image = this.images[index];

    // Prevent body scroll immediately to avoid flash
    document.body.classList.add('noscroll');

    // Set initial state for smooth opening
    this.lightbox.style.opacity = '0';
    this.lightboxImage.style.opacity = '0';
    this.lightboxImage.style.transform = 'scale(0.8)';
    this.lightboxTitle.style.opacity = '0';

    // Show lightbox container
    this.lightbox.classList.remove('hidden');
    this.lightbox.setAttribute('aria-hidden', 'false');

    // Set content
    this.lightboxImage.src = image.url;
    this.lightboxImage.alt = image.alt;
    this.lightboxTitle.textContent = image.name;

    // Smooth opening animation
    requestAnimationFrame(() => {
      // Fade in backdrop
      this.lightbox.style.transition = 'opacity 0.3s ease';
      this.lightbox.style.opacity = '1';

      // Animate image in with scale + fade
      this.lightboxImage.style.transition = 'opacity 0.4s ease 0.1s, transform 0.4s ease 0.1s';
      this.lightboxImage.style.opacity = '1';
      this.lightboxImage.style.transform = 'scale(1)';

      // Fade in caption after image
      setTimeout(() => {
        this.lightboxTitle.style.transition = 'opacity 0.3s ease';
        this.lightboxTitle.style.opacity = '1';
      }, 300);
    });

    // Focus management for accessibility (delayed to avoid flash)
    setTimeout(() => {
      const closeButton = document.querySelector('.lightbox-close');
      if (closeButton) {
        closeButton.focus();
      }
    }, 200);
  }

  /**
   * Closes the lightbox
   */
  closeLightbox() {
    this.lightboxOpen = false;

    // Smooth closing animation
    this.lightboxTitle.style.transition = 'opacity 0.2s ease';
    this.lightboxTitle.style.opacity = '0';

    this.lightboxImage.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    this.lightboxImage.style.opacity = '0';
    this.lightboxImage.style.transform = 'scale(0.9)';

    // Fade out backdrop
    setTimeout(() => {
      this.lightbox.style.transition = 'opacity 0.2s ease';
      this.lightbox.style.opacity = '0';
    }, 100);

    // Hide lightbox after animation completes
    setTimeout(() => {
      this.lightbox.classList.add('hidden');
      this.lightbox.setAttribute('aria-hidden', 'true');

      // Re-enable body scroll
      document.body.classList.remove('noscroll');

      // Return focus to the gallery item that was clicked
      const galleryItems = document.querySelectorAll('.gallery-item');
      if (galleryItems[this.currentImageIndex]) {
        galleryItems[this.currentImageIndex].focus();
      }
    }, 300);
  }

  /**
   * Shows the previous image in the lightbox
   */
  showPreviousImage() {
    const newIndex = this.currentImageIndex === 0
      ? this.images.length - 1
      : this.currentImageIndex - 1;

    this.updateLightboxImage(newIndex);
  }

  /**
   * Shows the next image in the lightbox
   */
  showNextImage() {
    const newIndex = this.currentImageIndex === this.images.length - 1
      ? 0
      : this.currentImageIndex + 1;

    this.updateLightboxImage(newIndex);
  }

  /**
   * Updates the lightbox with a new image
   * @param {number} index - Index of the new image
   */
  updateLightboxImage(index) {
    if (index < 0 || index >= this.images.length) return;

    const previousIndex = this.currentImageIndex;
    const image = this.images[index];

    // Determine slide direction based on navigation
    let direction;
    if (index > previousIndex || (previousIndex === this.images.length - 1 && index === 0)) {
      direction = 'next'; // Going forward (or wrapping from last to first)
    } else {
      direction = 'prev'; // Going backward (or wrapping from first to last)
    }

    // Handle wrap-around cases
    if (previousIndex === 0 && index === this.images.length - 1) {
      direction = 'prev'; // Wrapped backward
    }

    // Start exit animation
    this.lightboxImage.style.transition = 'transform 0.3s ease-out, opacity 0.2s ease-out';
    this.lightboxImage.style.transform = direction === 'next' ? 'translateX(-100px)' : 'translateX(100px)';
    this.lightboxImage.style.opacity = '0';

    // Fade out caption
    this.lightboxTitle.style.transition = 'opacity 0.2s ease-out';
    this.lightboxTitle.style.opacity = '0';

    setTimeout(() => {
      // Update content
      this.lightboxImage.src = image.url;
      this.lightboxImage.alt = image.alt;
      this.lightboxTitle.textContent = image.name;

      // Update current index after content is loaded
      this.currentImageIndex = index;

      // Reset position for enter animation (from opposite side)
      this.lightboxImage.style.transform = direction === 'next' ? 'translateX(100px)' : 'translateX(-100px)';

      // Use requestAnimationFrame for smooth animation
      requestAnimationFrame(() => {
        // Start enter animation
        this.lightboxImage.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
        this.lightboxImage.style.transform = 'translateX(0)';
        this.lightboxImage.style.opacity = '1';

        // Fade in caption with slight delay
        setTimeout(() => {
          this.lightboxTitle.style.transition = 'opacity 0.3s ease-out';
          this.lightboxTitle.style.opacity = '1';
        }, 100);
      });
    }, 200);
  }

  /**
   * Filters gallery by location (for future extension)
   * @param {string} location - Location to filter by
   */
  filterByLocation(location) {
    const filteredImages = location === 'all'
      ? this.images
      : this.images.filter(img =>
          img.name.toLowerCase().includes(location.toLowerCase())
        );

    this.renderFilteredGallery(filteredImages);
  }

  /**
   * Renders filtered gallery results (for future extension)
   * @param {Array} filteredImages - Filtered array of images
   */
  renderFilteredGallery(filteredImages) {
    this.galleryGrid.innerHTML = '';

    filteredImages.forEach((image) => {
      // Find original index for lightbox navigation
      const originalIndex = this.images.findIndex(img => img.url === image.url);
      const galleryItem = this.createGalleryItem(image, originalIndex);
      this.galleryGrid.appendChild(galleryItem);
    });
  }

  /**
   * Searches gallery by title or description (for future extension)
   * @param {string} query - Search query
   */
  searchGallery(query) {
    const searchResults = query === ''
      ? this.images
      : this.images.filter(img =>
          img.name.toLowerCase().includes(query.toLowerCase()) ||
          img.alt.toLowerCase().includes(query.toLowerCase())
        );

    this.renderFilteredGallery(searchResults);
  }
}

// Initialize gallery when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new Gallery();
});

// Export Gallery class for potential external use
export default Gallery;