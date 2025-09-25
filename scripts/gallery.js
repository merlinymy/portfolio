import { galleryArr } from "../assets/galleryArr.js";

/**
 * Gallery class handles the dynamic rendering and lightbox functionality
 * Modular design allows for easy extension with filters, search, etc.
 */
class Gallery {
  constructor() {
    this.images = galleryArr;
    this.filteredImages = galleryArr;
    this.currentImageIndex = 0;
    this.lightboxOpen = false;
    this.activeFilter = "Signature";
    this.scrollPosition = 0;

    this.galleryGrid = document.getElementById("gallery-grid");
    this.lightbox = document.getElementById("lightbox");
    this.lightboxImage = document.getElementById("lightbox-image");
    this.lightboxTitle = document.getElementById("lightbox-title");
    this.carouselCurrent = document.getElementById("carousel-current");
    this.carouselTotal = document.getElementById("carousel-total");
    this.thumbnailsContainer = document.getElementById("thumbnails-container");
    this.carouselDescription = document.getElementById("carousel-description");
    this.backToTopBtn = document.getElementById("back-to-top");
    this.galleryStatus = document.getElementById("gallery-status");

    this.init();
  }

  init() {
    this.setupFilterEvents();
    this.filterByTag(this.activeFilter);
    this.setupLightboxEvents();
    this.setupKeyboardEvents();
    this.setupBackToTop();
  }

  /**
   * Renders the gallery grid dynamically from galleryArr
   * Creates gallery items with proper accessibility attributes
   */
  renderGallery() {
    if (!this.galleryGrid) {
      console.error("Gallery grid element not found");
      return;
    }

    this.galleryGrid.innerHTML = "";

    this.filteredImages.forEach((image, index) => {
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
    const item = document.createElement("div");
    item.className = "gallery-item";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-label", `View image: ${image.name}`);

    // Create image container to maintain aspect ratio
    const imageContainer = document.createElement("div");
    imageContainer.className = "gallery-item-image-container";

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = image.alt;
    img.className = "gallery-item-image";
    img.loading = "lazy"; // Performance optimization

    const info = document.createElement("div");
    info.className = "gallery-item-info";

    const title = document.createElement("h3");
    title.className = "gallery-item-title";
    title.textContent = image.name;

    imageContainer.appendChild(img);
    info.appendChild(title);
    item.appendChild(imageContainer);
    item.appendChild(info);

    // Add click and keyboard event listeners
    const originalIndex = this.images.findIndex((img) => img.url === image.url);
    item.addEventListener("click", () =>
      this.openLightbox(index, originalIndex)
    );
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.openLightbox(index, originalIndex);
      }
    });

    return item;
  }

  /**
   * Sets up filter button event listeners
   */
  setupFilterEvents() {
    const filterButtons = document.querySelectorAll(".filter-btn");

    filterButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const filter = button.getAttribute("data-filter");
        this.setActiveFilter(button);
        this.filterByTag(filter);
      });
    });
  }

  /**
   * Sets the active filter button
   * @param {HTMLElement} activeButton - The button that was clicked
   */
  setActiveFilter(activeButton) {
    document.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    });
    activeButton.classList.add("active");
    activeButton.setAttribute("aria-pressed", "true");
    this.activeFilter = activeButton.getAttribute("data-filter");
  }

  /**
   * Filters gallery by tag with smooth animation
   * @param {string} tag - Tag to filter by, or 'all' to show all images
   */
  filterByTag(tag) {
    // Add filtering class for fade out animation
    this.galleryGrid.classList.add("filtering");

    setTimeout(() => {
      // Filter the images
      if (tag === "all") {
        this.filteredImages = this.images;
      } else {
        this.filteredImages = this.images.filter(
          (image) => image.tags && image.tags.includes(tag)
        );
      }

      // Re-render the gallery
      this.renderGallery();

      // Update status for screen readers
      if (this.galleryStatus) {
        const filterName = tag === "all" ? "All images" : tag;
        const count = this.filteredImages.length;
        this.galleryStatus.textContent = `Showing ${count} image${count !== 1 ? "s" : ""} in ${filterName} category`;
      }

      // Remove filtering class to fade in new content
      setTimeout(() => {
        this.galleryGrid.classList.remove("filtering");
      }, 50);
    }, 300);
  }

  /**
   * Sets up carousel event listeners
   */
  setupLightboxEvents() {
    const closeBtn = document.querySelector(".carousel-close");
    const prevBtn = document.querySelector(".carousel-nav-prev");
    const nextBtn = document.querySelector(".carousel-nav-next");
    const backdrop = document.querySelector(".carousel-backdrop");

    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.closeLightbox());
    }

    if (prevBtn) {
      prevBtn.addEventListener("click", () => this.showPreviousImage());
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => this.showNextImage());
    }

    if (backdrop) {
      backdrop.addEventListener("click", () => this.closeLightbox());
    }
  }

  /**
   * Sets up keyboard navigation for lightbox
   */
  setupKeyboardEvents() {
    document.addEventListener("keydown", (e) => {
      if (!this.lightboxOpen) return;

      switch (e.key) {
        case "Escape":
          this.closeLightbox();
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.showPreviousImage();
          break;
        case "ArrowRight":
          e.preventDefault();
          this.showNextImage();
          break;
      }
    });
  }

  /**
   * Opens the carousel with the specified image
   * @param {number} filteredIndex - Index in filtered array
   * @param {number} originalIndex - Index in original array (optional)
   */
  openLightbox(filteredIndex, originalIndex = null) {
    if (filteredIndex < 0 || filteredIndex >= this.filteredImages.length)
      return;

    this.currentImageIndex = filteredIndex;
    this.lightboxOpen = true;

    const image = this.filteredImages[filteredIndex];

    // Prevent body scroll immediately
    this.disableScroll();

    // Generate thumbnails
    this.generateThumbnails();

    // Update counter
    this.updateCounter();

    // Show carousel container
    this.lightbox.classList.remove("hidden");
    this.lightbox.setAttribute("aria-hidden", "false");

    // Set content
    this.lightboxImage.src = image.url;
    this.lightboxImage.alt = image.alt;
    this.lightboxTitle.textContent = image.name;
    this.carouselDescription.textContent = image.alt || "";

    // Update active thumbnail
    this.updateActiveThumbnail();

    // Focus management for accessibility
    setTimeout(() => {
      const closeButton = document.querySelector(".carousel-close");
      if (closeButton) {
        closeButton.focus();
      }
    }, 200);
  }

  /**
   * Closes the carousel
   */
  closeLightbox() {
    this.lightboxOpen = false;

    // Hide carousel
    this.lightbox.classList.add("hidden");
    this.lightbox.setAttribute("aria-hidden", "true");

    // Re-enable body scroll
    this.enableScroll();

    // Return focus to the gallery item that was clicked
    const galleryItems = document.querySelectorAll(".gallery-item");
    if (galleryItems[this.currentImageIndex]) {
      galleryItems[this.currentImageIndex].focus();
    }
  }

  /**
   * Shows the previous image in the lightbox
   */
  showPreviousImage() {
    const newIndex =
      this.currentImageIndex === 0
        ? this.filteredImages.length - 1
        : this.currentImageIndex - 1;

    this.updateLightboxImage(newIndex);
  }

  /**
   * Shows the next image in the lightbox
   */
  showNextImage() {
    const newIndex =
      this.currentImageIndex === this.filteredImages.length - 1
        ? 0
        : this.currentImageIndex + 1;

    this.updateLightboxImage(newIndex);
  }

  /**
   * Updates the carousel with a new image
   * @param {number} index - Index of the new image
   */
  updateLightboxImage(index) {
    if (index < 0 || index >= this.filteredImages.length) return;

    const previousIndex = this.currentImageIndex;
    const image = this.filteredImages[index];

    // Determine slide direction based on navigation
    let direction;
    if (
      index > previousIndex ||
      (previousIndex === this.filteredImages.length - 1 && index === 0)
    ) {
      direction = "next";
    } else {
      direction = "prev";
    }

    // Handle wrap-around cases
    if (previousIndex === 0 && index === this.filteredImages.length - 1) {
      direction = "prev";
    }

    // Show loading spinner
    const loadingElement = document.querySelector(".carousel-loading");
    if (loadingElement) {
      loadingElement.classList.remove("hidden");
    }

    // Start exit animation
    this.lightboxImage.style.transition =
      "transform 0.3s ease-out, opacity 0.2s ease-out";
    this.lightboxImage.style.transform =
      direction === "next" ? "translateX(-50px)" : "translateX(50px)";
    this.lightboxImage.style.opacity = "0";

    setTimeout(() => {
      // Update content
      this.lightboxImage.src = image.url;
      this.lightboxImage.alt = image.alt;
      this.lightboxTitle.textContent = image.name;
      this.carouselDescription.textContent = image.alt || "";

      // Update current index
      this.currentImageIndex = index;

      // Update counter and thumbnails
      this.updateCounter();
      this.updateActiveThumbnail();

      // Reset position for enter animation
      this.lightboxImage.style.transform =
        direction === "next" ? "translateX(50px)" : "translateX(-50px)";

      // Image load handler
      const handleImageLoad = () => {
        // Hide loading spinner
        if (loadingElement) {
          loadingElement.classList.add("hidden");
        }

        // Start enter animation
        requestAnimationFrame(() => {
          this.lightboxImage.style.transition =
            "transform 0.3s ease-out, opacity 0.3s ease-out";
          this.lightboxImage.style.transform = "translateX(0)";
          this.lightboxImage.style.opacity = "1";
        });

        // Remove event listener
        this.lightboxImage.removeEventListener("load", handleImageLoad);
      };

      // Add load event listener
      this.lightboxImage.addEventListener("load", handleImageLoad);

      // Fallback in case image is already loaded
      if (this.lightboxImage.complete) {
        handleImageLoad();
      }
    }, 200);
  }

  /**
   * Generates thumbnail strip for the carousel
   */
  generateThumbnails() {
    if (!this.thumbnailsContainer) return;

    this.thumbnailsContainer.innerHTML = "";

    this.filteredImages.forEach((image, index) => {
      const thumbnailItem = document.createElement("div");
      thumbnailItem.className = "thumbnail-item";
      thumbnailItem.setAttribute("tabindex", "0");
      thumbnailItem.setAttribute("role", "button");
      thumbnailItem.setAttribute("aria-label", `View image: ${image.name}`);

      const thumbnailImg = document.createElement("img");
      thumbnailImg.src = image.url;
      thumbnailImg.alt = image.alt;
      thumbnailImg.loading = "lazy";

      thumbnailItem.appendChild(thumbnailImg);

      // Click handler
      thumbnailItem.addEventListener("click", () => {
        this.updateLightboxImage(index);
      });

      // Keyboard handler
      thumbnailItem.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.updateLightboxImage(index);
        }
      });

      this.thumbnailsContainer.appendChild(thumbnailItem);
    });
  }

  /**
   * Updates the carousel counter
   */
  updateCounter() {
    if (this.carouselCurrent && this.carouselTotal) {
      this.carouselCurrent.textContent = this.currentImageIndex + 1;
      this.carouselTotal.textContent = this.filteredImages.length;
    }
  }

  /**
   * Updates the active thumbnail
   */
  updateActiveThumbnail() {
    const thumbnails =
      this.thumbnailsContainer.querySelectorAll(".thumbnail-item");
    thumbnails.forEach((thumbnail, index) => {
      if (index === this.currentImageIndex) {
        thumbnail.classList.add("active");
        // Scroll thumbnail into view
        thumbnail.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
      } else {
        thumbnail.classList.remove("active");
      }
    });
  }

  /**
   * Disables scrolling on mobile devices properly
   */
  disableScroll() {
    // Store current scroll position
    this.scrollPosition =
      window.pageYOffset || document.documentElement.scrollTop;

    // Apply noscroll class and set top position to prevent jump
    document.body.style.top = `-${this.scrollPosition}px`;
    document.body.classList.add("noscroll");
  }

  /**
   * Re-enables scrolling and restores position
   */
  enableScroll() {
    // Remove noscroll class
    document.body.classList.remove("noscroll");
    document.body.style.top = "";

    // Restore scroll position
    window.scrollTo(0, this.scrollPosition);
  }

  /**
   * Sets up back to top button functionality
   */
  setupBackToTop() {
    if (!this.backToTopBtn) return;

    let isThrottled = false;

    // Throttled scroll handler for better performance
    const handleScroll = () => {
      if (isThrottled) return;

      isThrottled = true;
      requestAnimationFrame(() => {
        this.toggleBackToTopButton();
        isThrottled = false;
      });
    };

    // Add scroll event listener
    window.addEventListener("scroll", handleScroll);

    // Add click event listener
    this.backToTopBtn.addEventListener("click", () => {
      this.scrollToTop();
    });

    // Add keyboard event listener
    this.backToTopBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.scrollToTop();
      }
    });

    // Initial check
    this.toggleBackToTopButton();
  }

  /**
   * Toggles back to top button visibility based on scroll position
   */
  toggleBackToTopButton() {
    if (!this.backToTopBtn) return;

    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const documentHeight = document.documentElement.scrollHeight;
    const windowHeight = window.innerHeight;
    const scrollPercentage = scrollTop / (documentHeight - windowHeight);

    // Show button if page is long enough and user has scrolled past 50%
    const isPageLong = documentHeight > windowHeight * 1.5; // Page is at least 1.5x viewport height
    const hasScrolledPast50Percent = scrollPercentage > 0.1;

    if (isPageLong && hasScrolledPast50Percent) {
      this.backToTopBtn.classList.remove("hidden");
    } else {
      this.backToTopBtn.classList.add("hidden");
    }
  }

  /**
   * Smoothly scrolls to the top of the page
   */
  scrollToTop() {
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  /**
   * Filters gallery by location (for future extension)
   * @param {string} location - Location to filter by
   */
  filterByLocation(location) {
    const filteredImages =
      location === "all"
        ? this.images
        : this.images.filter((img) =>
            img.name.toLowerCase().includes(location.toLowerCase())
          );

    this.renderFilteredGallery(filteredImages);
  }

  /**
   * Renders filtered gallery results (for future extension)
   * @param {Array} filteredImages - Filtered array of images
   */
  renderFilteredGallery(filteredImages) {
    this.galleryGrid.innerHTML = "";

    filteredImages.forEach((image) => {
      // Find original index for lightbox navigation
      const originalIndex = this.images.findIndex(
        (img) => img.url === image.url
      );
      const galleryItem = this.createGalleryItem(image, originalIndex);
      this.galleryGrid.appendChild(galleryItem);
    });
  }

  /**
   * Searches gallery by title or description (for future extension)
   * @param {string} query - Search query
   */
  searchGallery(query) {
    const searchResults =
      query === ""
        ? this.images
        : this.images.filter(
            (img) =>
              img.name.toLowerCase().includes(query.toLowerCase()) ||
              img.alt.toLowerCase().includes(query.toLowerCase())
          );

    this.renderFilteredGallery(searchResults);
  }
}

// Initialize gallery when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new Gallery();
});

// Export Gallery class for potential external use
export default Gallery;
