// @ts-check
function debounce(func, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

function _getNodePath(node) {
  if (!node) return "unknown";
  if (node.nodeType === Node.TEXT_NODE) {
    return _getNodePath(node.parentNode) + ":text";
  }

  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  if (!element) return "unknown";

  // Start building path for this element
  let path = [];
  let currentElement = element;
  
  // Build the full path up to the root or a unique parent
  while (currentElement && currentElement !== document.documentElement) {
    // Get a descriptor for the current element
    let descriptor = currentElement.tagName.toLowerCase();
    
    // Add ID if available (most specific identifier)
    if (currentElement.id) {
      descriptor += "#" + currentElement.id;
      // If we find an ID, we can stop here as it should be unique on the page
      path.unshift(descriptor);
      break;
    }
    
    // Add classes (up to 3) if available
    if (currentElement.classList && currentElement.classList.length) {
      const classes = Array.from(currentElement.classList).slice(0, 3);
      descriptor += "." + classes.join(".");
    }
    
    // Add data attributes for more specificity
    if (currentElement.dataset) {
      const dataAttrs = Object.keys(currentElement.dataset);
      for (const attr of dataAttrs.slice(0, 3)) {
        const value = currentElement.dataset[attr];
        if (value) {
          descriptor += `[data-${attr}="${value}"]`;
        }
      }
    }
    
    // Add position-based selector for elements without IDs, to ensure uniqueness
    if (!currentElement.id) {
      // Find the element's position among siblings with the same tag
      const siblings = Array.from(currentElement.parentNode.children)
        .filter(el => el.tagName === currentElement.tagName);
      
      if (siblings.length > 1) {
        const index = siblings.indexOf(currentElement) + 1;
        descriptor += `:nth-of-type(${index})`;
      }
    }
    
    // For headings, add text content for better identification
    if (/^h[1-6]$/.test(currentElement.tagName.toLowerCase()) && currentElement.textContent) {
      const headingText = currentElement.textContent.trim().substring(0, 20);
      if (headingText) {
        descriptor += `[title="${headingText}${headingText.length >= 20 ? "..." : ""}"]`;
      }
    }
    
    // Add this component to the path
    path.unshift(descriptor);
    
    // Get the parent for the next iteration
    currentElement = currentElement.parentElement;
  }
  
  // Join all path parts with spaces to create a valid CSS selector
  // If no path was built (e.g., for document.documentElement), return the basic element descriptor
  return path.length > 0 ? path.join(" > ") : element.tagName.toLowerCase();
}

function _getPageSection(node) {
  if (!node) return "unknown";

  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  if (!element) return "unknown";

  // Walk up the DOM to find major section containers
  let current = element;
  while (current && current !== document.body) {
    // Check for common TypeDoc section identifiers
    if (current.id) {
      if (current.id === "tsd-search") return "search";
      if (current.id === "tsd-sidebar") return "sidebar";
      if (current.id.includes("tsd-nav")) return "navigation";
      if (current.id === "tsd-footer") return "footer";
      if (current.id === "tsd-header") return "header";
      if (current.id === "tsd-main") return "main-content";
    }

    // Check by class or other attributes
    if (current.classList) {
      if (current.classList.contains("tsd-page-title")) return "page-title";
      if (current.classList.contains("tsd-panel")) return "content-panel";
      if (current.classList.contains("tsd-signatures")) return "signatures";
      if (current.classList.contains("tsd-returns")) return "returns";
      if (current.classList.contains("tsd-parameters")) return "parameters";
      if (current.classList.contains("tsd-comment")) return "comment";
      if (current.classList.contains("tsd-sources")) return "sources";
    }

    current = current.parentElement;
  }

  return "other";
}

function _getSelectionDetails() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!range) return null;

  // Get containing element path
  const containerPath = _getNodePath(range.commonAncestorContainer);

  // Get start and end element paths
  const startPath = _getNodePath(range.startContainer);
  const endPath = _getNodePath(range.endContainer);

  // Get the parent element content type
  let contentType = "text";
  const parentElement = /** @type {HTMLElement | null} */ (
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
  );

  if (parentElement) {
    if (parentElement.closest("code, pre")) {
      contentType = "code";
    } else if (parentElement.closest("h1, h2, h3, h4, h5, h6")) {
      contentType = "heading";
    } else if (parentElement.closest("table")) {
      contentType = "table";
    } else if (parentElement.closest("blockquote")) {
      contentType = "quote";
    } else if (parentElement.closest("li")) {
      contentType = "list-item";
    } else if (parentElement.closest(".tsd-signature")) {
      contentType = "signature";
    } else if (parentElement.closest(".tsd-comment")) {
      contentType = "comment";
    } else if (parentElement.closest(".tsd-sources")) {
      contentType = "source";
    } else if (parentElement.closest(".tsd-parameters")) {
      contentType = "parameters";
    }
  }

  // Get selection length (character count)
  const selectedText = selection.toString();
  const textLength = selectedText ? selectedText.length : 0;

  return {
    container: containerPath,
    start: startPath,
    startOffset: range.startOffset,
    end: endPath,
    endOffset: range.endOffset,
    length: textLength,
    type: contentType,
    pageSection: _getPageSection(range.commonAncestorContainer),
    charPreview: selectedText
      ? selectedText.substring(0, 15) + (selectedText.length > 15 ? "..." : "")
      : "",
  };
}

// @ts-ignore
window.dataLayer = window.dataLayer || [];
// @ts-ignore
function gtag() { dataLayer.push(arguments); }

// set default consent
gtag("consent", "default", {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
  functionality_storage: "denied",
  personalization_storage: "denied",
  security_storage: "granted",
  wait_for_update: 300, // give the page time to load the consent preferences before sending data
});

gtag("js", new Date());
gtag("config", "${gaID}");


document.addEventListener("DOMContentLoaded", function () {
  // read cookie consent status from localStorage
  // be sure to keep page scope in sync with the extra.scope field in mkdocs.yml
  const pageScope = new URL("/langgraph/", new URL(location.href));
  const __md_get = (key, storage = localStorage, scope = pageScope) =>
    JSON.parse(storage.getItem(scope.pathname + "." + key) ?? "{}");

  const userConsentSetting = __md_get("__consent");
  const userAnalyticsPreference = !!userConsentSetting?.analytics;

  const consentValue = userAnalyticsPreference ? "granted" : "denied";
  gtag("consent", "update", {
    analytics_storage: consentValue,
  });
  gtag("consent", "update", {
    functionality_storage: consentValue,
  });
  gtag("consent", "update", {
    personalization_storage: consentValue,
  });

  // set up page instrumentation
  if (userAnalyticsPreference) {
    /** @type {HTMLInputElement | null} */
    const field = document.querySelector("#tsd-search input");

    let reportedSearchTerm = "";

    field?.addEventListener(
      "input",
      debounce(() => {
        reportedSearchTerm = field.value;
        gtag("event", "search", { search_term: field.value });
      }, 1000)
    );

    /** @param {KeyboardEvent} e */
    function onKeyDown(e) {
      if (e.key === "Enter" && reportedSearchTerm !== field?.value) {
        gtag("event", "search", { search_term: field?.value });
      }
    }
    field?.addEventListener("keydown", onKeyDown);

    // Setup copy event tracking
    document.addEventListener("copy", () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        const selectionDetails = _getSelectionDetails();
        if (selectionDetails) {
          gtag("event", "copyText", { selectionDetails });
        }
      }
    });

    // Setup code copy button tracking
    const copyButtons = Array.from(
      document.querySelectorAll("pre > button")
    ).filter((btn) => btn.textContent?.trim() === "Copy");

    for (const btn of copyButtons) {
      function onClick(e) {
        if (e.target.previousElementSibling instanceof HTMLElement) {
          const codeElement = e.target.previousElementSibling;
          if (codeElement) {
            const codeDetails = {
              codeType: "code-block",
              path: _getNodePath(codeElement),
              length: codeElement.innerText?.length || 0,
              language: codeElement.className.match(/language-(\\w+)/)
                ? codeElement.className.match(/language-(\\w+)/)[1]
                : "unknown",
              pageSection: _getPageSection(codeElement),
            };

            gtag("event", "copyCode", { codeDetails });
          }
        }
      }
      btn.addEventListener("click", onClick);
    }
  }
});

const script = document.createElement("script")
script.async = true
script.src = "https://www.googletagmanager.com/gtag/js?id=${gaID}"

/* Inject script tag */
document.head.appendChild(script)
