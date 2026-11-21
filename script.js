/* ==========================================================================
   L'Oréal Smart Routine & Product Advisor
   Product Browsing, Search, Selection, localStorage, RTL, Modal & AI Chat
   ========================================================================== */

/* Class-hosted Cloudflare Worker endpoint (holds the OpenAI key securely) */
const WORKER_URL = "https://loreal-chatbot.kalaya-nelson5.workers.dev/";

/* localStorage keys (used only for UI preferences & selected product IDs) */
const STORAGE_KEY = "lorealSelectedProductIds";
const DIRECTION_STORAGE_KEY = "lorealTextDirection";

/* Clean SVG fallback displayed if a product image URL on the CDN fails to load */
const FALLBACK_PRODUCT_IMAGE =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <rect width="160" height="160" rx="12" fill="#faf8f5"/>
      <rect x="46" y="42" width="68" height="76" rx="10" fill="#eee8df" stroke="#e3a535" stroke-width="2"/>
      <rect x="64" y="26" width="32" height="18" rx="4" fill="#252525"/>
      <text x="80" y="86" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#252525">L'ORÉAL</text>
    </svg>`
  );

/* Get references to DOM elements */
const rtlToggleBtn = document.getElementById("rtlToggleBtn");
const categoryFilter = document.getElementById("categoryFilter");
const productSearch = document.getElementById("productSearch");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const productsContainer = document.getElementById("productsContainer");
const selectedProductsList = document.getElementById("selectedProductsList");
const clearAllBtn = document.getElementById("clearAllBtn");
const generateRoutineBtn = document.getElementById("generateRoutine");
const chatForm = document.getElementById("chatForm");
const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const chatWindow = document.getElementById("chatWindow");

/* Product details modal DOM elements */
const productModal = document.getElementById("productModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const modalDoneBtn = document.getElementById("modalDoneBtn");
const modalSelectBtn = document.getElementById("modalSelectBtn");
const modalProductImage = document.getElementById("modalProductImage");
const modalProductCategory = document.getElementById("modalProductCategory");
const modalProductBrand = document.getElementById("modalProductBrand");
const modalProductName = document.getElementById("modalProductName");
const modalProductDescription = document.getElementById(
  "modalProductDescription"
);

/* System prompt instructing the AI how to act as a L'Oréal beauty advisor */
const SYSTEM_PROMPT = `You are a knowledgeable, warm, and honest L'Oréal beauty and skincare advisor.

TOPIC RESTRICTIONS:
You may ONLY answer questions related to:
- Skincare
- Haircare
- Makeup
- Fragrance
- Beauty products
- Product ingredients
- Product application
- Beauty routines

If the user asks about anything unrelated to beauty, personal care, or their product routine (for example: coding, math, history, sports, politics, or general trivia), politely explain that you focus exclusively on beauty and product routines, and invite them to ask a skincare, haircare, makeup, fragrance, or routine question instead.

ROUTINE & ADVICE GUIDELINES:
1. Remember the user's selected products and any routine already generated earlier in this conversation so you can answer follow-up questions accurately.
2. When building a routine, base it strictly on the selected products provided. Never recommend products the user did not select as though they were part of their selected routine.
3. Explain the exact step-by-step order (first, second, third, etc.), how and when to use each product, and separate Morning (AM) and Evening (PM) steps when appropriate.
4. Share helpful application tips and note any important ingredient compatibility or layering concerns (such as spacing retinol with exfoliating acids or benzoyl peroxide, or pairing vitamin C with sunscreen).
5. If the user's selected products are insufficient for a complete routine (for example, missing a cleanser, moisturizer, or sunscreen), explain that honestly without pretending unselected products are included.
6. Avoid unsupported medical claims, and advise the user to consult a dermatologist or qualified healthcare professional for medical skin concerns.
7. When the user asks about current L'Oréal product launches, recent formula updates, availability, or up-to-date beauty and ingredient information beyond the catalog, use live web search when helpful while keeping all answers focused on beauty and personal care.`;

/* Application state:
   - allProducts caches the list loaded from products.json
   - productsLoadPromise ensures products.json is fetched once (and resets on failure)
   - selectedProducts stores the user's chosen product objects
   - messages stores the full conversation history (system, user, assistant)
   - lastSyncedProductSignature tracks which product IDs were last sent to the AI
   - isRequestInFlight prevents multiple requests from being sent at once
   - activeModalProductId tracks which product is open in the modal
   - lastFocusedElement restores keyboard focus when the modal closes */
let allProducts = [];
let productsLoadPromise = null;
let selectedProducts = [];
const messages = [{ role: "system", content: SYSTEM_PROMPT }];
let lastSyncedProductSignature = "";
let isRequestInFlight = false;
let activeModalProductId = null;
let lastFocusedElement = null;

/* ==========================================================================
   RTL / LTR Direction Switching
   ========================================================================== */

/* Apply "ltr" or "rtl" to the <html> element and sync the toggle button */
function applyDirection(direction) {
  const isRtl = direction === "rtl";
  document.documentElement.setAttribute("dir", isRtl ? "rtl" : "ltr");

  if (rtlToggleBtn) {
    rtlToggleBtn.setAttribute("aria-pressed", String(isRtl));
    const labelSpan = rtlToggleBtn.querySelector("span");
    if (labelSpan) {
      labelSpan.textContent = isRtl ? "LTR" : "RTL";
    }
  }
}

/* Restore saved direction preference on page load */
function restoreDirectionPreference() {
  try {
    const savedDirection = localStorage.getItem(DIRECTION_STORAGE_KEY);
    if (savedDirection === "rtl" || savedDirection === "ltr") {
      applyDirection(savedDirection);
      return;
    }
  } catch {
    // Ignore storage access errors
  }

  applyDirection("ltr");
}

/* Toggle between LTR and RTL and save the preference */
function toggleDirection() {
  const currentDirection =
    document.documentElement.getAttribute("dir") === "rtl" ? "rtl" : "ltr";
  const nextDirection = currentDirection === "rtl" ? "ltr" : "rtl";
  applyDirection(nextDirection);

  try {
    localStorage.setItem(DIRECTION_STORAGE_KEY, nextDirection);
  } catch {
    // Ignore storage access errors
  }
}

/* ==========================================================================
   Product Data Loading & Safe Image Helpers
   ========================================================================== */

/* Show initial placeholder until user selects a category or searches */
function showInitialPlaceholder() {
  productsContainer.innerHTML = `
    <div class="placeholder-message">
      Select a category or enter a search term to view products
    </div>
  `;
}

showInitialPlaceholder();

/* Fix unencoded "%" signs in URLs (e.g., "1.5%" -> "1.5%25") without altering products.json */
function getSafeImageUrl(url) {
  if (!url) {
    return FALLBACK_PRODUCT_IMAGE;
  }

  return String(url).replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
}

/* Attach a graceful fallback so missing CDN images never appear broken */
function attachImageFallbacks(container) {
  const images = container.querySelectorAll("img");
  images.forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        if (img.src !== FALLBACK_PRODUCT_IMAGE) {
          img.src = FALLBACK_PRODUCT_IMAGE;
        }
      },
      { once: true }
    );
  });
}

/* Load product data from products.json (with validation and retry on failure) */
async function loadProducts() {
  if (allProducts.length > 0) {
    return allProducts;
  }

  if (!productsLoadPromise) {
    productsLoadPromise = fetch("products.json")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load products (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (!data || !Array.isArray(data.products)) {
          throw new Error("Invalid products.json structure");
        }
        allProducts = data.products;
        return allProducts;
      })
      .catch((error) => {
        // Reset promise so future attempts can retry cleanly
        productsLoadPromise = null;
        throw error;
      });
  }

  return productsLoadPromise;
}

/* ==========================================================================
   localStorage Helpers (Saving & Restoring Selected Product IDs)
   ========================================================================== */

/* Save ONLY unique product IDs to localStorage (no full objects or secrets) */
function saveSelectedProductIds() {
  try {
    const uniqueIds = [...new Set(selectedProducts.map((product) => product.id))];

    if (uniqueIds.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(uniqueIds));
  } catch (error) {
    console.warn("Could not save selected products to localStorage:", error);
  }
}

/* Read and validate saved product IDs from localStorage */
function loadSavedProductIds() {
  try {
    const rawValue = localStorage.getItem(STORAGE_KEY);

    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);

    if (!Array.isArray(parsed)) {
      localStorage.removeItem(STORAGE_KEY);
      return [];
    }

    const validUniqueIds = [];
    parsed.forEach((item) => {
      const id = Number(item);
      if (Number.isInteger(id) && id > 0 && !validUniqueIds.includes(id)) {
        validUniqueIds.push(id);
      }
    });

    return validUniqueIds;
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore secondary storage errors
    }
    return [];
  }
}

/* Restore previously selected products from products.json when the page loads */
async function restoreSelectedProducts() {
  const savedIds = loadSavedProductIds();

  if (savedIds.length === 0) {
    return;
  }

  try {
    const products = await loadProducts();
    const restoredProducts = [];

    savedIds.forEach((savedId) => {
      const matchingProduct = products.find((product) => product.id === savedId);

      if (
        matchingProduct &&
        !restoredProducts.some((item) => item.id === matchingProduct.id)
      ) {
        restoredProducts.push(matchingProduct);
      }
    });

    selectedProducts = restoredProducts;
    saveSelectedProductIds();

    renderSelectedProducts();
    syncProductGridSelection();
  } catch (error) {
    console.warn("Could not restore selected products:", error);
  }
}

/* ==========================================================================
   Product Filtering, Search & Selection Logic
   ========================================================================== */

/* Safely escape HTML characters before inserting text or attributes */
function escapeHTML(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Normalize text for case-insensitive and accent-insensitive matching
   (e.g., "lancome" matches "Lancôme" and "mineral" matches "Minéral") */
function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/* Filter products using BOTH the selected category and the search query */
async function filterAndDisplayProducts() {
  const selectedCategory = categoryFilter.value;
  const rawSearchTerm = productSearch.value.trim();
  const normalizedQuery = normalizeText(rawSearchTerm);

  clearSearchBtn.hidden = rawSearchTerm.length === 0;

  if (!selectedCategory && !normalizedQuery) {
    showInitialPlaceholder();
    return;
  }

  let products;
  try {
    products = await loadProducts();
  } catch {
    productsContainer.innerHTML = `
      <div class="placeholder-message">
        Unable to load the product catalog right now. Please refresh and try again.
      </div>
    `;
    return;
  }

  const searchKeywords = normalizedQuery.split(/\s+/).filter(Boolean);

  const filteredProducts = products.filter((product) => {
    const matchesCategory =
      !selectedCategory ||
      selectedCategory === "all" ||
      product.category === selectedCategory;

    if (!matchesCategory) {
      return false;
    }

    if (searchKeywords.length === 0) {
      return true;
    }

    const searchableText = normalizeText(
      `${product.name} ${product.brand} ${product.description} ${product.category}`
    );

    return searchKeywords.every((keyword) => searchableText.includes(keyword));
  });

  displayProducts(filteredProducts, rawSearchTerm);
}

/* Helper to check whether a product ID is already in selectedProducts */
function isProductSelected(productId) {
  return selectedProducts.some((product) => product.id === productId);
}

/* Toggle a product in or out of the selectedProducts array */
function toggleProductSelection(productId) {
  if (isProductSelected(productId)) {
    selectedProducts = selectedProducts.filter(
      (product) => product.id !== productId
    );
  } else {
    const productToAdd = allProducts.find(
      (product) => product.id === productId
    );
    if (productToAdd && !isProductSelected(productToAdd.id)) {
      selectedProducts.push(productToAdd);
    }
  }

  saveSelectedProductIds();
  renderSelectedProducts();
  syncProductGridSelection();
  updateModalSelectButton();
}

/* Remove a single product by ID (used by individual remove buttons) */
function removeSelectedProduct(productId) {
  selectedProducts = selectedProducts.filter(
    (product) => product.id !== productId
  );

  saveSelectedProductIds();
  renderSelectedProducts();
  syncProductGridSelection();
  updateModalSelectButton();
}

/* Remove every product from selectedProducts and clear localStorage */
function clearAllSelectedProducts() {
  selectedProducts = [];

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("Could not clear localStorage:", error);
  }

  renderSelectedProducts();
  syncProductGridSelection();
  updateModalSelectButton();
}

/* Sync the visual highlight on any currently visible product cards */
function syncProductGridSelection() {
  const productCards = productsContainer.querySelectorAll(".product-card");

  productCards.forEach((card) => {
    const cardProductId = Number(card.dataset.productId);
    const selected = isProductSelected(cardProductId);

    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  });
}

/* Keep the modal's Add/Remove button synced with current selection state */
function updateModalSelectButton() {
  if (activeModalProductId === null) {
    return;
  }

  const selected = isProductSelected(activeModalProductId);
  modalSelectBtn.textContent = selected
    ? "Remove from Routine"
    : "Add to Routine";
  modalSelectBtn.classList.toggle("is-selected", selected);
}

/* Open the product description modal using data loaded from products.json */
async function openProductModal(productId) {
  let products;
  try {
    products = await loadProducts();
  } catch {
    return;
  }

  const product = products.find((item) => item.id === productId);
  if (!product) {
    return;
  }

  activeModalProductId = product.id;
  lastFocusedElement = document.activeElement;

  modalProductImage.src = getSafeImageUrl(product.image);
  modalProductImage.alt = product.name;
  modalProductImage.onerror = () => {
    if (modalProductImage.src !== FALLBACK_PRODUCT_IMAGE) {
      modalProductImage.src = FALLBACK_PRODUCT_IMAGE;
    }
  };
  modalProductCategory.textContent = product.category;
  modalProductBrand.textContent = product.brand;
  modalProductName.textContent = product.name;
  modalProductDescription.textContent = product.description;

  updateModalSelectButton();

  productModal.hidden = false;
  document.body.style.overflow = "hidden";
  closeModalBtn.focus();
}

/* Close the product description modal and restore focus */
function closeProductModal() {
  productModal.hidden = true;
  document.body.style.overflow = "";
  activeModalProductId = null;

  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
    lastFocusedElement.focus();
  }
}

/* Render the Selected Products section using the selectedProducts array */
function renderSelectedProducts() {
  clearAllBtn.disabled = selectedProducts.length === 0;

  if (selectedProducts.length === 0) {
    selectedProductsList.innerHTML = "";
    return;
  }

  selectedProductsList.innerHTML = selectedProducts
    .map((product) => {
      const safeBrand = escapeHTML(product.brand);
      const safeName = escapeHTML(product.name);

      return `
        <div class="selected-item" data-product-id="${product.id}">
          <div class="selected-item-info">
            <span class="selected-item-brand">${safeBrand}</span>
            <span class="selected-item-name">${safeName}</span>
          </div>
          <button
            type="button"
            class="remove-item-btn"
            data-remove-id="${product.id}"
            aria-label="Remove ${safeName}"
            title="Remove ${safeName}"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      `;
    })
    .join("");
}

/* Create HTML for displaying product cards in the grid */
function displayProducts(products, searchTerm = "") {
  if (products.length === 0) {
    const emptyBox = document.createElement("div");
    emptyBox.className = "placeholder-message";
    emptyBox.textContent = searchTerm
      ? `No products matched "${searchTerm}". Try another keyword, switch categories, or clear your search.`
      : "No products found in this category.";

    productsContainer.innerHTML = "";
    productsContainer.appendChild(emptyBox);
    return;
  }

  productsContainer.innerHTML = products
    .map((product) => {
      const selected = isProductSelected(product.id);
      const selectedClass = selected ? "selected" : "";
      const safeName = escapeHTML(product.name);
      const safeBrand = escapeHTML(product.brand);
      const safeImage = escapeHTML(getSafeImageUrl(product.image));

      return `
        <div
          class="product-card ${selectedClass}"
          data-product-id="${product.id}"
          role="button"
          tabindex="0"
          aria-pressed="${selected}"
        >
          <img src="${safeImage}" alt="${safeName}">
          <div class="product-info">
            <h3>${safeName}</h3>
            <p>${safeBrand}</p>
            <button
              type="button"
              class="view-details-btn"
              data-details-id="${product.id}"
              aria-label="View details for ${safeName}"
            >
              <i class="fa-regular fa-eye" aria-hidden="true"></i>
              <span>View Details</span>
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  attachImageFallbacks(productsContainer);
}

/* ==========================================================================
   AI Conversation History, Routine Generator & Follow-Up Chat
   ========================================================================== */

/* Format inline Markdown (**bold** and safe http/https links) */
function formatInlineMarkdown(escapedLine) {
  return escapedLine
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/* Convert plain text / simple markdown from the AI into clean HTML */
function formatAssistantReply(replyText) {
  const escaped = escapeHTML(replyText);
  const lines = escaped.split("\n");
  const htmlParts = [];
  let inList = false;

  lines.forEach((rawLine) => {
    const trimmed = rawLine.trim();

    // Handle bullet points (- item or * item)
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (!inList) {
        htmlParts.push("<ul>");
        inList = true;
      }
      htmlParts.push(`<li>${formatInlineMarkdown(trimmed.slice(2))}</li>`);
      return;
    }

    if (inList) {
      htmlParts.push("</ul>");
      inList = false;
    }

    if (trimmed.startsWith("### ")) {
      htmlParts.push(`<h4>${formatInlineMarkdown(trimmed.slice(4))}</h4>`);
    } else if (trimmed.startsWith("## ")) {
      htmlParts.push(`<h3>${formatInlineMarkdown(trimmed.slice(3))}</h3>`);
    } else if (trimmed.startsWith("# ")) {
      htmlParts.push(`<h3>${formatInlineMarkdown(trimmed.slice(2))}</h3>`);
    } else if (trimmed === "") {
      htmlParts.push("<br>");
    } else {
      htmlParts.push(`<p>${formatInlineMarkdown(trimmed)}</p>`);
    }
  });

  if (inList) {
    htmlParts.push("</ul>");
  }

  return htmlParts.join("");
}

/* Extract safe citation links from Responses API citations or url_citation annotations */
function renderCitationsHTML(citations) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return "";
  }

  const uniqueLinks = [];
  citations.forEach((note) => {
    const rawUrl =
      typeof note === "string"
        ? note
        : note?.url_citation?.url || note?.url;
    const rawTitle =
      typeof note === "string"
        ? note
        : note?.url_citation?.title || note?.title || rawUrl;

    if (
      typeof rawUrl === "string" &&
      (rawUrl.startsWith("https://") || rawUrl.startsWith("http://")) &&
      !uniqueLinks.some((item) => item.url === rawUrl)
    ) {
      let domain = "";
      try {
        domain = new URL(rawUrl).hostname.replace(/^www\./, "");
      } catch {
        domain = "";
      }

      uniqueLinks.push({
        url: rawUrl,
        title: String(rawTitle || rawUrl).trim(),
        domain,
      });
    }
  });

  if (uniqueLinks.length === 0) {
    return "";
  }

  const linksMarkup = uniqueLinks
    .map((link) => {
      const domainBadge = link.domain
        ? `<span class="chat-citation-domain">${escapeHTML(link.domain)}</span>`
        : "";

      return `
        <li>
          <a href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">
            <span class="chat-citation-title">${escapeHTML(link.title)}</span>
            ${domainBadge}
          </a>
        </li>
      `;
    })
    .join("");

  return `
    <div class="chat-citations">
      <div class="chat-citations-title">
        <i class="fa-solid fa-globe" aria-hidden="true"></i>
        <span>Sources</span>
      </div>
      <ul>${linksMarkup}</ul>
    </div>
  `;
}

/* Format a subtle local timestamp (e.g., "09:08 PM") for chat bubbles */
function getFormattedTime() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* Create and append a styled user or AI message bubble to chatWindow */
function appendChatMessage(role, content, extraClass = "", annotations = []) {
  const messageEl = document.createElement("div");
  messageEl.className = `chat-message ${role} ${extraClass}`.trim();

  const metaEl = document.createElement("div");
  metaEl.className = "chat-message-meta";

  const senderEl = document.createElement("span");
  senderEl.className = "chat-message-sender";
  senderEl.textContent = role === "user" ? "You" : "L'Oréal Advisor";

  const timeEl = document.createElement("span");
  timeEl.className = "chat-message-time";
  timeEl.textContent = getFormattedTime();

  metaEl.appendChild(senderEl);
  metaEl.appendChild(timeEl);

  const bodyEl = document.createElement("div");
  bodyEl.className = "chat-message-body";

  if (role === "assistant" && !extraClass) {
    bodyEl.innerHTML =
      formatAssistantReply(content) + renderCitationsHTML(annotations);
  } else {
    bodyEl.textContent = content;
  }

  messageEl.appendChild(metaEl);
  messageEl.appendChild(bodyEl);

  chatWindow.appendChild(messageEl);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return messageEl;
}

/* Update an existing loading bubble with the final AI reply or an error */
function updateAssistantBubble(
  bubbleEl,
  text,
  isError = false,
  annotations = []
) {
  bubbleEl.classList.remove("loading");
  if (isError) {
    bubbleEl.classList.add("error");
  }

  const timeEl = bubbleEl.querySelector(".chat-message-time");
  if (timeEl) {
    timeEl.textContent = getFormattedTime();
  }

  const bodyEl = bubbleEl.querySelector(".chat-message-body");
  if (bodyEl) {
    if (isError) {
      bodyEl.textContent = text;
    } else {
      bodyEl.innerHTML =
        formatAssistantReply(text) + renderCitationsHTML(annotations);
    }
  }

  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* Lock or unlock request controls while waiting for the Cloudflare Worker */
function setRequestLoadingState(isLoading) {
  isRequestInFlight = isLoading;
  generateRoutineBtn.disabled = isLoading;
  sendBtn.disabled = isLoading;
  chatWindow.setAttribute("aria-busy", String(isLoading));
}

/* Return a stable string signature of currently selected product IDs */
function getSelectedProductsSignature() {
  return selectedProducts.map((product) => product.id).join(",");
}

/* Build a clean summary of ONLY the user's selected products */
function buildSelectedProductsSummary(products) {
  return products
    .map(
      (product, index) =>
        `${index + 1}. Name: ${product.name}\n   Brand: ${product.brand}\n   Category: ${product.category}\n   Description: ${product.description}`
    )
    .join("\n\n");
}

/* Extract reply text and url_citation links if raw Responses API JSON is returned */
function extractFromResponsesOutput(data) {
  const textParts = [];
  const citations = [];

  if (Array.isArray(data?.output)) {
    data.output.forEach((item) => {
      if (item?.type === "message" && Array.isArray(item.content)) {
        item.content.forEach((part) => {
          if (part?.type === "output_text" && typeof part.text === "string") {
            textParts.push(part.text);
            if (Array.isArray(part.annotations)) {
              part.annotations.forEach((ann) => {
                if (ann?.type === "url_citation") {
                  citations.push(ann);
                }
              });
            }
          }
        });
      }
    });
  }

  const fallbackText =
    textParts.join("\n").trim() ||
    (typeof data?.output_text === "string" ? data.output_text.trim() : "");

  return {
    reply: fallbackText,
    citations,
  };
}

/* Send the FULL messages array to the Cloudflare Worker and return reply + citations */
async function sendConversationToWorker() {
  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages }),
  });

  if (!response.ok) {
    let errorDetail = `Worker responded with status ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData?.error?.message) {
        errorDetail = `${errorDetail}: ${errorData.error.message}`;
      } else if (typeof errorData?.error === "string") {
        errorDetail = `${errorDetail}: ${errorData.error}`;
      }
    } catch {
      // Ignore non-JSON error responses
    }
    throw new Error(errorDetail);
  }

  const data = await response.json();

  if (data?.error?.message) {
    throw new Error(data.error.message);
  }
  if (typeof data?.error === "string") {
    throw new Error(data.error);
  }

  // 1. Clean JSON format returned by the updated Responses API Worker:
  //    { reply: "...", citations: [{ title, url }], usedWebSearch: true/false }
  if (typeof data?.reply === "string" && data.reply.trim()) {
    return {
      reply: data.reply,
      annotations: Array.isArray(data.citations)
        ? data.citations
        : Array.isArray(data.sources)
        ? data.sources
        : Array.isArray(data.annotations)
        ? data.annotations
        : [],
    };
  }

  // 2. Raw OpenAI Responses API JSON format (if Worker forwards OpenAI response directly)
  if (Array.isArray(data?.output) || typeof data?.output_text === "string") {
    const parsed = extractFromResponsesOutput(data);
    if (parsed.reply) {
      return {
        reply: parsed.reply,
        annotations: parsed.citations,
      };
    }
  }

  // 3. Backwards-compatible OpenAI Chat Completions format
  const replyContent = data?.choices?.[0]?.message?.content;
  if (typeof replyContent === "string" && replyContent.trim()) {
    return {
      reply: replyContent,
      annotations: data.choices[0].message.annotations || [],
    };
  }

  throw new Error("Invalid response format from the AI service.");
}

/* Generate a personalized routine from the currently selected products */
async function generatePersonalizedRoutine() {
  if (isRequestInFlight) {
    return;
  }

  if (selectedProducts.length === 0) {
    appendChatMessage(
      "assistant",
      "Please select at least one product above before generating your personalized routine."
    );
    return;
  }

  const currentSignature = getSelectedProductsSignature();
  const productDetails = buildSelectedProductsSummary(selectedProducts);
  const userRequestText = `Please create a personalized routine using ONLY these selected products:\n\n${productDetails}`;

  appendChatMessage(
    "user",
    `Generate a routine for my ${selectedProducts.length} selected product(s): ${selectedProducts
      .map((product) => product.name)
      .join(", ")}.`
  );

  const loadingBubble = appendChatMessage(
    "assistant",
    "Creating your personalized L'Oréal routine…",
    "loading"
  );

  messages.push({ role: "user", content: userRequestText });
  setRequestLoadingState(true);

  try {
    const { reply, annotations } = await sendConversationToWorker();
    messages.push({ role: "assistant", content: reply });
    lastSyncedProductSignature = currentSignature;
    updateAssistantBubble(loadingBubble, reply, false, annotations);
  } catch (error) {
    console.error("Routine generation error:", error);
    messages.pop();
    updateAssistantBubble(
      loadingBubble,
      "Sorry, I couldn't connect to the routine advisor right now. Please check your internet connection or try again in a moment.",
      true
    );
  } finally {
    setRequestLoadingState(false);
  }
}

/* Send a follow-up question while keeping the full conversation history */
async function handleFollowUpQuestion(questionText) {
  if (!questionText || isRequestInFlight) {
    return;
  }

  const currentSignature = getSelectedProductsSignature();
  let messageContentForAI = questionText;

  // Include current product tray context if this is the first message with selections
  // or if the user changed their selected products since the last API call
  if (currentSignature !== lastSyncedProductSignature) {
    if (selectedProducts.length > 0) {
      messageContentForAI = `The user currently has these selected products:\n\n${buildSelectedProductsSummary(
        selectedProducts
      )}\n\nUser question: ${questionText}`;
    } else if (lastSyncedProductSignature !== "") {
      messageContentForAI = `Note: The user has cleared all products from their selected tray.\n\nUser question: ${questionText}`;
    }
  }

  appendChatMessage("user", questionText);
  const loadingBubble = appendChatMessage(
    "assistant",
    "Thinking…",
    "loading"
  );

  messages.push({ role: "user", content: messageContentForAI });
  setRequestLoadingState(true);

  try {
    const { reply, annotations } = await sendConversationToWorker();
    messages.push({ role: "assistant", content: reply });
    lastSyncedProductSignature = currentSignature;
    updateAssistantBubble(loadingBubble, reply, false, annotations);
    userInput.value = "";
  } catch (error) {
    console.error("Follow-up chat error:", error);
    messages.pop();
    updateAssistantBubble(
      loadingBubble,
      "Sorry, I couldn't reach the beauty advisor right now. Please try sending your question again.",
      true
    );
  } finally {
    setRequestLoadingState(false);
    userInput.focus();
  }
}

/* ==========================================================================
   Event Listeners & Initialization
   ========================================================================== */

if (rtlToggleBtn) {
  rtlToggleBtn.addEventListener("click", toggleDirection);
}

categoryFilter.addEventListener("change", () => {
  filterAndDisplayProducts();
});

productSearch.addEventListener("input", () => {
  filterAndDisplayProducts();
});

clearSearchBtn.addEventListener("click", () => {
  productSearch.value = "";
  filterAndDisplayProducts();
  productSearch.focus();
});

productsContainer.addEventListener("click", (e) => {
  const detailsBtn = e.target.closest(".view-details-btn");
  if (detailsBtn) {
    e.stopPropagation();
    const productId = Number(detailsBtn.dataset.detailsId);
    openProductModal(productId);
    return;
  }

  const clickedCard = e.target.closest(".product-card");
  if (!clickedCard) {
    return;
  }

  const productId = Number(clickedCard.dataset.productId);
  toggleProductSelection(productId);
});

productsContainer.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") {
    return;
  }

  if (e.target.closest(".view-details-btn")) {
    return;
  }

  const focusedCard = e.target.closest(".product-card");
  if (!focusedCard) {
    return;
  }

  e.preventDefault();
  const productId = Number(focusedCard.dataset.productId);
  toggleProductSelection(productId);
});

selectedProductsList.addEventListener("click", (e) => {
  const removeBtn = e.target.closest(".remove-item-btn");
  if (!removeBtn) {
    return;
  }

  const productId = Number(removeBtn.dataset.removeId);
  removeSelectedProduct(productId);
});

clearAllBtn.addEventListener("click", () => {
  clearAllSelectedProducts();
});

generateRoutineBtn.addEventListener("click", () => {
  generatePersonalizedRoutine();
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const questionText = userInput.value.trim();
  if (!questionText) {
    return;
  }

  handleFollowUpQuestion(questionText);
});

closeModalBtn.addEventListener("click", closeProductModal);
modalDoneBtn.addEventListener("click", closeProductModal);

productModal.addEventListener("click", (e) => {
  if (e.target === productModal) {
    closeProductModal();
  }
});

modalSelectBtn.addEventListener("click", () => {
  if (activeModalProductId !== null) {
    toggleProductSelection(activeModalProductId);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !productModal.hidden) {
    closeProductModal();
  }
});

/* Initialize saved direction preference & restore saved product selections */
restoreDirectionPreference();
restoreSelectedProducts();