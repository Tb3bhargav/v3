const DOM_NOISE_TAGS = new Set([
  "script",
  "style",
  "svg",
  "iframe",
  "video",
  "audio",
  "source",
  "noscript",
  "canvas"
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "textbox",
  "combobox",
  "option",
  "navigation",
  "menu"
]);

const MAX_SCAN_ELEMENTS = 260;

let hostElement = null;
let shadowRoot = null;
let cursorElement = null;
let hudElement = null;
let trailCanvas = null;
let trailAnimation = null;
let mouseController = null;
let keyboardInjector = null;
let scrollManipulator = null;

const latestNodesById = new Map();
const latestRecordsById = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function easeInOutCubic(t) {
  if (t < 0.5) {
    return 4 * t * t * t;
  }
  return 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function shortText(value, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function hashText(value) {
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

class TrailAnimation {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.points = [];
    this.rafId = null;
    this.resize();
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * ratio));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * ratio));
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
    if (this.ctx) {
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
  }

  addPoint(x, y) {
    this.points.push({
      x,
      y,
      life: 1,
      radius: 1.8 + Math.random() * 2.3
    });
    if (this.points.length > 140) {
      this.points.shift();
    }
    this.start();
  }

  start() {
    if (this.rafId) return;
    const loop = () => {
      this.render();
      if (this.points.length > 0) {
        this.rafId = requestAnimationFrame(loop);
      } else {
        this.rafId = null;
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  render() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (let i = this.points.length - 1; i >= 0; i -= 1) {
      const point = this.points[i];
      point.life -= 0.018;
      if (point.life <= 0) {
        this.points.splice(i, 1);
        continue;
      }
      this.ctx.beginPath();
      this.ctx.fillStyle = "rgba(92, 104, 255, " + (0.45 * point.life).toFixed(3) + ")";
      this.ctx.arc(point.x, point.y, point.radius + (1 - point.life) * 2.2, 0, Math.PI * 2);
      this.ctx.fill();
    }

    for (let i = 1; i < this.points.length; i += 1) {
      const a = this.points[i - 1];
      const b = this.points[i];
      const alpha = Math.min(a.life, b.life) * 0.28;
      this.ctx.strokeStyle = "rgba(84, 120, 255, " + alpha.toFixed(3) + ")";
      this.ctx.lineWidth = 1.6;
      this.ctx.beginPath();
      this.ctx.moveTo(a.x, a.y);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
    }
  }
}

class MouseController {
  constructor(cursor, trail) {
    this.cursor = cursor;
    this.trail = trail;
    this.hideTimer = null;
    this.isVisible = false;
    this.position = {
      x: Math.round(window.innerWidth * 0.5),
      y: Math.round(window.innerHeight * 0.5)
    };
    this.cursor.style.opacity = "0";
    this.cursor.style.transform = "translate(" + this.position.x + "px, " + this.position.y + "px)";
  }

  showCursor() {
    if (this.isVisible) return;
    this.isVisible = true;
    this.cursor.style.opacity = "1";
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.cursor.style.opacity = "0";
      this.isVisible = false;
    }, 900);
  }

  updateCursor() {
    this.cursor.style.transform = "translate(" + this.position.x + "px, " + this.position.y + "px)";
    this.trail.addPoint(this.position.x, this.position.y);
  }

  async moveTo(x, y) {
    this.showCursor();
    const targetX = clamp(Math.round(x), 0, Math.max(1, window.innerWidth - 1));
    const targetY = clamp(Math.round(y), 0, Math.max(1, window.innerHeight - 1));
    const startX = this.position.x;
    const startY = this.position.y;
    const distance = Math.hypot(targetX - startX, targetY - startY);

    const duration = clamp(Math.round(240 + distance * 1.25), 240, 1700);

    await new Promise((resolve) => {
      const startedAt = performance.now();
      const tick = (timestamp) => {
        const elapsed = timestamp - startedAt;
        const progress = clamp(elapsed / duration, 0, 1);
        const eased = easeInOutCubic(progress);
        this.position.x = Math.round(startX + (targetX - startX) * eased);
        this.position.y = Math.round(startY + (targetY - startY) * eased);
        this.updateCursor();
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });

    this.scheduleHide();
  }

  async focusTarget(target) {
    if (!target) return;
    try {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    } catch (error) {
      // Ignore unsupported scroll behavior.
    }
    await sleep(60);
    try {
      target.focus({ preventScroll: true });
    } catch (error) {
      try {
        target.focus();
      } catch (innerError) {
        // Ignore focus failures.
      }
    }
  }

  dispatchMouseEvent(target, type, x, y) {
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      view: window
    }));
  }

  async clickAt(target, x, y) {
    await this.moveTo(x, y);
    await this.focusTarget(target);
    createRipple(x, y);
    this.dispatchMouseEvent(target, "mousemove", x, y);
    this.dispatchMouseEvent(target, "mousedown", x, y);
    this.dispatchMouseEvent(target, "mouseup", x, y);
    if (typeof target.click === "function") {
      target.click();
    } else {
      this.dispatchMouseEvent(target, "click", x, y);
    }
    this.scheduleHide();
    return {
      action: "click",
      x,
      y,
      targetTag: target.tagName ? target.tagName.toLowerCase() : "unknown"
    };
  }
}

class KeyboardInjector {
  getValueSetter(target) {
    if (!target) return null;
    if (target instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      return descriptor && descriptor.set ? descriptor.set : null;
    }
    if (target instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      return descriptor && descriptor.set ? descriptor.set : null;
    }
    return null;
  }

  mapKeyCode(key) {
    const map = {
      Enter: "Enter",
      Tab: "Tab",
      Escape: "Escape",
      Backspace: "Backspace",
      Shift: "ShiftLeft",
      Control: "ControlLeft",
      Alt: "AltLeft",
      Meta: "MetaLeft",
      ArrowUp: "ArrowUp",
      ArrowDown: "ArrowDown",
      ArrowLeft: "ArrowLeft",
      ArrowRight: "ArrowRight"
    };
    if (map[key]) return map[key];
    if (key.length === 1) {
      const upper = key.toUpperCase();
      if (/[A-Z]/.test(upper)) return "Key" + upper;
      if (/[0-9]/.test(key)) return "Digit" + key;
    }
    return key;
  }

  dispatchKeyEvent(target, phase, key, modifiers) {
    const code = this.mapKeyCode(key);
    const event = new KeyboardEvent(phase, {
      bubbles: true,
      cancelable: true,
      key,
      code,
      shiftKey: Boolean(modifiers.shiftKey),
      ctrlKey: Boolean(modifiers.ctrlKey),
      metaKey: Boolean(modifiers.metaKey),
      altKey: Boolean(modifiers.altKey)
    });
    target.dispatchEvent(event);
  }

  setNativeValue(target, nextValue) {
    if (target.isContentEditable) {
      target.textContent = nextValue;
      return;
    }

    const setter = this.getValueSetter(target);
    if (setter) {
      setter.call(target, nextValue);
    } else {
      target.value = nextValue;
    }
  }

  async typeText(target, text, modifiers = {}) {
    if (!target) throw new Error("No target element available for typing.");

    const normalizedText = String(text || "");
    // Clear existing value so typing replaces instead of appending.
    this.setNativeValue(target, "");
    target.dispatchEvent(new Event("input", { bubbles: true }));
    let currentValue = "";

    for (const char of normalizedText) {
      this.dispatchKeyEvent(target, "keydown", char, modifiers);
      this.dispatchKeyEvent(target, "keypress", char, modifiers);

      currentValue += char;
      this.setNativeValue(target, currentValue);
      target.dispatchEvent(new Event("input", { bubbles: true }));

      this.dispatchKeyEvent(target, "keyup", char, modifiers);
      await sleep(24 + Math.round(Math.random() * 28));
    }

    target.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      action: "type",
      textLength: normalizedText.length
    };
  }

  async pressKey(target, key, modifiers = {}) {
    if (!target) target = document.activeElement || document.body;

    this.dispatchKeyEvent(target, "keydown", key, modifiers);
    this.dispatchKeyEvent(target, "keypress", key, modifiers);
    this.dispatchKeyEvent(target, "keyup", key, modifiers);

    if (key === "Enter" && target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      const form = target.closest("form");
      if (form) {
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitBtn) submitBtn.click();
        else if (form.requestSubmit) form.requestSubmit();
        else form.submit();
      }
    }

    return {
      action: "press",
      key
    };
  }
}

class ScrollManipulator {
  isScrollable(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    const allowsScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
    return allowsScroll && element.scrollHeight > element.clientHeight + 20;
  }

  findMainScroller() {
    let best = document.scrollingElement || document.documentElement || document.body;
    let bestSpan = best ? best.scrollHeight - best.clientHeight : 0;

    const candidates = document.querySelectorAll("body, main, section, article, div");
    for (const candidate of candidates) {
      if (!this.isScrollable(candidate)) continue;
      const span = candidate.scrollHeight - candidate.clientHeight;
      if (span > bestSpan) {
        best = candidate;
        bestSpan = span;
      }
    }

    return best || document.scrollingElement || document.documentElement || document.body;
  }

  scroll(action) {
    const scroller = this.findMainScroller();
    if (!scroller) throw new Error("No scroll container found.");

    const absolute = Boolean(action.absolute);
    const x = Number(action.x);
    const y = Number(action.y);

    if (absolute && Number.isFinite(y)) {
      scroller.scrollTo({
        left: Number.isFinite(x) ? x : scroller.scrollLeft,
        top: y,
        behavior: "smooth"
      });
      return {
        action: "scroll",
        mode: "absolute",
        x: Number.isFinite(x) ? x : scroller.scrollLeft,
        y
      };
    }

    const deltaX = Number.isFinite(Number(action.deltaX)) ? Number(action.deltaX) : 0;
    const deltaY = Number.isFinite(Number(action.deltaY)) ? Number(action.deltaY) : 320;

    scroller.scrollBy({
      left: deltaX,
      top: deltaY,
      behavior: "smooth"
    });

    return {
      action: "scroll",
      mode: "delta",
      deltaX,
      deltaY
    };
  }
}

function initAgentUI() {
  if (hostElement && shadowRoot) return;

  hostElement = document.createElement("div");
  hostElement.id = "comet-agent-host";
  hostElement.style.position = "fixed";
  hostElement.style.top = "0";
  hostElement.style.left = "0";
  hostElement.style.width = "100vw";
  hostElement.style.height = "100vh";
  hostElement.style.pointerEvents = "none";
  hostElement.style.zIndex = "2147483647";

  document.documentElement.appendChild(hostElement);
  shadowRoot = hostElement.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
    }
    .trail-canvas {
      position: absolute;
      inset: 0;
      pointer-events: none;
      mix-blend-mode: normal;
      opacity: 0.42;
    }
    .virtual-mouse {
      position: absolute;
      width: 22px;
      height: 22px;
      background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%235b7dff' stroke='%23f8fbff' stroke-width='1'><path d='M4 0l16 12-7 2 3 7-3 2-3-7-4 5z'/></svg>") no-repeat;
      background-size: contain;
      pointer-events: none;
      transform: translate(50vw, 50vh);
      filter: drop-shadow(0 0 5px rgba(95, 132, 255, 0.65));
      transition: opacity 140ms linear;
      z-index: 100;
      will-change: transform;
    }
    .ripple {
      position: absolute;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      pointer-events: none;
      background: radial-gradient(circle, rgba(119, 147, 255, 0.8) 0%, rgba(35, 52, 120, 0.12) 58%, rgba(0, 0, 0, 0) 78%);
      animation: rippleBurst 420ms ease-out forwards;
    }
    @keyframes rippleBurst {
      0% { transform: scale(0.2); opacity: 1; }
      100% { transform: scale(3.2); opacity: 0; }
    }
    .hud {
      position: absolute;
      bottom: 22px;
      left: 22px;
      max-width: min(68vw, 420px);
      background: rgba(9, 13, 26, 0.9);
      border: 1px solid rgba(110, 146, 255, 0.55);
      color: #d6e2ff;
      font-family: Consolas, "SF Mono", monospace;
      font-size: 12px;
      line-height: 1.45;
      letter-spacing: 0.2px;
      padding: 10px 14px;
      border-radius: 8px;
      box-shadow: 0 12px 28px rgba(2, 7, 20, 0.5), 0 0 18px rgba(97, 124, 255, 0.26);
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 180ms ease, transform 180ms ease, border-color 180ms ease;
      z-index: 110;
      pointer-events: none;
    }
    .hud.visible {
      opacity: 1;
      transform: translateY(0px);
    }
    .hud.error {
      border-color: rgba(255, 95, 109, 0.85);
      color: #ffd5db;
    }
    .hud.success {
      border-color: rgba(108, 221, 176, 0.86);
      color: #d9ffe9;
    }
    .render-burst {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(circle at 50% 40%, rgba(124, 149, 255, 0.32), rgba(9, 14, 36, 0.45) 42%, rgba(4, 7, 19, 0.7) 100%);
      animation: renderBurst 120ms ease-out forwards;
      z-index: 90;
    }
    @keyframes renderBurst {
      0% { opacity: 0; transform: scale(0.98); }
      40% { opacity: 1; transform: scale(1); }
      100% { opacity: 0; transform: scale(1.03); }
    }
  `;
  shadowRoot.appendChild(style);

  trailCanvas = document.createElement("canvas");
  trailCanvas.className = "trail-canvas";
  shadowRoot.appendChild(trailCanvas);

  cursorElement = document.createElement("div");
  cursorElement.className = "virtual-mouse";
  shadowRoot.appendChild(cursorElement);

  hudElement = document.createElement("div");
  hudElement.className = "hud";
  shadowRoot.appendChild(hudElement);

  trailAnimation = new TrailAnimation(trailCanvas);
  mouseController = new MouseController(cursorElement, trailAnimation);
  keyboardInjector = new KeyboardInjector();
  scrollManipulator = new ScrollManipulator();

  window.addEventListener("resize", () => {
    if (trailAnimation) trailAnimation.resize();
  });
}

function updateHUD(text, type) {
  if (!hudElement) return;
  hudElement.textContent = "> " + text;
  hudElement.className = "hud visible";
  if (type === "error") hudElement.classList.add("error");
  if (type === "success") hudElement.classList.add("success");

  clearTimeout(window.__cometHudTimeout);
  window.__cometHudTimeout = setTimeout(() => {
    if (hudElement) hudElement.className = "hud";
  }, 4200);
}

function createRipple(x, y) {
  if (!shadowRoot) return;
  const ripple = document.createElement("div");
  ripple.className = "ripple";
  ripple.style.left = x - 13 + "px";
  ripple.style.top = y - 13 + "px";
  shadowRoot.appendChild(ripple);
  setTimeout(() => {
    ripple.remove();
  }, 420);
}

function showRenderBurst() {
  // Keep this transparent so navigations do not visually obstruct page content.
}

function isNodeVisible(node, style) {
  if (!node || !style) return false;
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  if (rect.bottom < -450 || rect.top > window.innerHeight + 450) return false;
  return true;
}

function getNodeDepth(node) {
  let depth = 0;
  let current = node;
  while (current && current.parentElement) {
    depth += 1;
    current = current.parentElement;
    if (depth > 80) break;
  }
  return depth;
}

function classifyElement(node, style) {
  const tag = node.tagName ? node.tagName.toLowerCase() : "";
  const role = (node.getAttribute("role") || "").toLowerCase();
  const cursorPointer = style.cursor === "pointer";

  const isAnchor = tag === "a" && Boolean(node.getAttribute("href"));
  const isFormControl = ["input", "textarea", "select", "button", "option", "label"].includes(tag);
  const hasInteractiveRole = INTERACTIVE_ROLES.has(role);
  const hasOnclick = typeof node.onclick === "function" || node.hasAttribute("onclick");
  const isEditable = node.isContentEditable;
  const hasTabIndex = Number(node.getAttribute("tabindex")) >= 0;

  const clickable = isAnchor || isFormControl || hasInteractiveRole || hasOnclick || cursorPointer || isEditable || hasTabIndex;
  const navigational = role === "navigation" || role === "menu" || tag === "nav";

  return {
    clickable,
    formControl: isFormControl,
    navigational,
    role,
    tag
  };
}

function computeScore(record) {
  let score = 0;
  if (record.clickable) score += 5;
  if (record.formControl) score += 4;
  if (record.navigational) score += 3;
  if (record.text) score += Math.min(3.2, record.text.length / 28);
  if (record.width * record.height < 220) score -= 1.5;
  if (record.depth > 14) score -= Math.min(3, (record.depth - 14) * 0.25);
  return Number(score.toFixed(2));
}

function buildElementRecord(node, classification) {
  const rect = node.getBoundingClientRect();
  const text = shortText(
    node.innerText ||
    node.value ||
    node.placeholder ||
    node.getAttribute("aria-label") ||
    node.getAttribute("title") ||
    ""
  );

  const centerX = Math.round(rect.left + rect.width / 2);
  const centerY = Math.round(rect.top + rect.height / 2);
  const depth = getNodeDepth(node);

  const descriptor = [
    classification.tag,
    classification.role ? "role=" + classification.role : "",
    node.id ? "#" + node.id : "",
    text ? '"' + text + '"' : ""
  ].filter(Boolean).join(" ");

  const elementId = [
    classification.tag,
    Math.round(rect.left),
    Math.round(rect.top),
    Math.round(rect.width),
    Math.round(rect.height),
    hashText(text || node.id || classification.role)
  ].join(":");

  const record = {
    elementId,
    tag: classification.tag,
    role: classification.role,
    text,
    description: shortText(descriptor, 160),
    x: centerX,
    y: centerY,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    depth,
    clickable: classification.clickable,
    formControl: classification.formControl,
    navigational: classification.navigational
  };

  record.score = computeScore(record);
  return record;
}

function extractInteractiveRecords(maxElements) {
  latestNodesById.clear();
  latestRecordsById.clear();

  const records = [];
  const roots = [document.documentElement];
  const visitedRoots = new Set();
  const startedAt = performance.now();

  while (roots.length && records.length < maxElements) {
    const root = roots.shift();
    if (!root || visitedRoots.has(root)) continue;
    visitedRoots.add(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let current = walker.currentNode;

    while (current && records.length < maxElements) {
      if (current.shadowRoot) {
        roots.push(current.shadowRoot);
      }

      if (current !== root) {
        const tag = current.tagName ? current.tagName.toLowerCase() : "";
        if (!DOM_NOISE_TAGS.has(tag)) {
          const style = window.getComputedStyle(current);
          if (isNodeVisible(current, style)) {
            const classification = classifyElement(current, style);
            if (classification.clickable || classification.formControl || classification.navigational) {
              const record = buildElementRecord(current, classification);
              records.push(record);
              latestNodesById.set(record.elementId, current);
              latestRecordsById.set(record.elementId, record);
            }
          }
        }
      }

      current = walker.nextNode();
    }
  }

  return {
    records,
    latencyMs: Math.round(performance.now() - startedAt)
  };
}

function optimizeForTokenLimit(records, softLimitTokens) {
  let working = records.map((record) => ({ ...record }));
  let tokenEstimate = estimateTokens(working);
  let prunedCount = 0;

  while (working.length > 1 && tokenEstimate > softLimitTokens) {
    working.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return b.depth - a.depth;
    });
    working.shift();
    prunedCount += 1;
    tokenEstimate = estimateTokens(working);
  }

  return {
    elements: working,
    tokenEstimate,
    prunedCount
  };
}

function extractPageState(options = {}) {
  const softLimitTokens = Number(options.softLimitTokens) > 0
    ? Number(options.softLimitTokens)
    : 1800;
  const maxElements = Number(options.maxElements) > 0
    ? Math.min(Number(options.maxElements), MAX_SCAN_ELEMENTS)
    : MAX_SCAN_ELEMENTS;

  const raw = extractInteractiveRecords(maxElements);
  const optimized = optimizeForTokenLimit(raw.records, softLimitTokens);

  return {
    url: window.location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    },
    rawElementCount: raw.records.length,
    elements: optimized.elements,
    tokenEstimate: optimized.tokenEstimate,
    prunedCount: optimized.prunedCount,
    softLimitTokens,
    extractionLatencyMs: raw.latencyMs,
    fallbackRecommended: optimized.elements.length < 5
  };
}

function resolveActionTarget(action) {
  const elementId = action.elementId || "";
  const directRecord = elementId ? latestRecordsById.get(elementId) : null;
  let target = elementId ? latestNodesById.get(elementId) : null;

  let x = Number(action.x);
  let y = Number(action.y);
  if (!Number.isFinite(x) && directRecord) x = directRecord.x;
  if (!Number.isFinite(y) && directRecord) y = directRecord.y;

  if ((!target || !target.isConnected) && Number.isFinite(x) && Number.isFinite(y)) {
    target = document.elementFromPoint(x, y);
  }

  if ((!target || !target.isConnected) && action.targetHint) {
    const hint = String(action.targetHint).toLowerCase();
    for (const [candidateId, record] of latestRecordsById.entries()) {
      const haystack = (record.text + " " + record.description).toLowerCase();
      if (haystack.includes(hint)) {
        target = latestNodesById.get(candidateId) || target;
        if (!Number.isFinite(x)) x = record.x;
        if (!Number.isFinite(y)) y = record.y;
        break;
      }
    }
  }

  if (!target || !target.isConnected) {
    target = document.activeElement || document.body;
  }

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    if (rect) {
      x = Math.round(rect.left + rect.width / 2);
      y = Math.round(rect.top + rect.height / 2);
    } else {
      x = Math.round(window.innerWidth * 0.5);
      y = Math.round(window.innerHeight * 0.5);
    }
  }

  return {
    target,
    x: clamp(Math.round(x), 0, Math.max(1, window.innerWidth - 1)),
    y: clamp(Math.round(y), 0, Math.max(1, window.innerHeight - 1))
  };
}

async function executeAction(actionData) {
  const action = actionData && actionData.action
    ? String(actionData.action).toLowerCase().trim()
    : "";

  if (!action) {
    throw new Error("Action type is required.");
  }

  if (action === "scroll") {
    return scrollManipulator.scroll(actionData);
  }

  const resolved = resolveActionTarget(actionData);
  const target = resolved.target;

  if (action === "click") {
    return mouseController.clickAt(target, resolved.x, resolved.y);
  }

  if (action === "type") {
    await mouseController.moveTo(resolved.x, resolved.y);
    await mouseController.focusTarget(target);

    const modifiers = {
      shiftKey: Boolean(actionData.shiftKey),
      ctrlKey: Boolean(actionData.ctrlKey),
      metaKey: Boolean(actionData.metaKey),
      altKey: Boolean(actionData.altKey)
    };

    const typingResult = await keyboardInjector.typeText(target, actionData.text || "", modifiers);
    return {
      ...typingResult,
      x: resolved.x,
      y: resolved.y
    };
  }

  if (action === "press") {
    await mouseController.focusTarget(target);
    const key = actionData.key || "Enter";
    const pressResult = await keyboardInjector.pressKey(target, key, {
      shiftKey: Boolean(actionData.shiftKey),
      ctrlKey: Boolean(actionData.ctrlKey),
      metaKey: Boolean(actionData.metaKey),
      altKey: Boolean(actionData.altKey)
    });
    return {
      ...pressResult,
      x: resolved.x,
      y: resolved.y
    };
  }

  if (action === "move") {
    await mouseController.moveTo(resolved.x, resolved.y);
    return {
      action: "move",
      x: resolved.x,
      y: resolved.y
    };
  }

  throw new Error("Unsupported action: " + action);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: "Missing message type." });
    return;
  }

  if (msg.type === "PING") {
    sendResponse({ ok: true, pong: true });
    return;
  }

  if (msg.type === "UPDATE_HUD") {
    if (hudElement) {
      updateHUD(msg.message || "", msg.msgType || "info");
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "SHOW_RENDER_BURST") {
    showRenderBurst();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "EXTRACT_PAGE_STATE") {
    try {
      const pageState = extractPageState(msg.options || {});
      sendResponse(pageState);
    } catch (error) {
      sendResponse({
        error: String(error && error.message ? error.message : error),
        elements: []
      });
    }
    return;
  }

  if (msg.type === "EXECUTE_ACTION") {
    initAgentUI();
    executeAction(msg.action || {})
      .then((result) => {
        sendResponse({ ok: true, result });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error && error.message ? error.message : error)
        });
      });
    return true;
  }

  sendResponse({ ok: false, error: "Unknown content message type: " + msg.type });
});