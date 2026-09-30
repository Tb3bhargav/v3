const LOOP_FAILURE_CAP = 50;
const MAX_SWARM_TABS = 10;
const DOM_FALLBACK_THRESHOLD = 5;
const DEFAULT_SOFT_LIMIT_TOKENS = 1800;
const MAX_CONTEXT_ACTIONS = 20;
const SETTINGS_STORAGE_KEY = "comet.settings";

const DEFAULT_SETTINGS = {
  providerOrder: ["groq", "openai", "local"],
  providers: {
    groq: {
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      reasoningModel: "openai/gpt-oss-120b",
      visionModel: "meta-llama/llama-4-scout-17b-16e-instruct",
      apiKeys: [],
      requiresKey: true,
      supportsJsonMode: true
    },
    openai: {
      endpoint: "https://api.openai.com/v1/chat/completions",
      reasoningModel: "gpt-4.1-mini",
      visionModel: "gpt-4.1-mini",
      apiKeys: [],
      requiresKey: true,
      supportsJsonMode: true
    },
    local: {
      endpoint: "http://localhost:11434/v1/chat/completions",
      reasoningModel: "qwen2.5:14b",
      visionModel: "llava:13b",
      apiKeys: [],
      requiresKey: false,
      supportsJsonMode: false
    }
  }
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

function stripMarkdownCodeFences(text) {
  if (typeof text !== "string") return "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : text.trim();
}

function safeParseJSON(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;

  const stripped = stripMarkdownCodeFences(String(raw));
  try {
    return JSON.parse(stripped);
  } catch (error) {
    // Continue with fallback parsing.
  }

  const objectMatch = stripped.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (error) {
      // Continue with sanitization.
    }
  }

  const sanitized = stripped
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    .replace(/\u0000/g, "");

  try {
    return JSON.parse(sanitized);
  } catch (error) {
    return { raw: stripped };
  }
}

function compact(value, maxLen) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve({ ok: false, timeout: true });
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status !== "complete") return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve({ ok: true, timeout: false });
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function parseLineSeparatedKeys(rawText) {
  if (!rawText) return [];
  if (Array.isArray(rawText)) return rawText.map((key) => String(key).trim()).filter(Boolean);
  return String(rawText)
    .split(/\r?\n/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function normalizeProviderOrder(orderText, existingProviders) {
  if (!orderText) return Object.keys(existingProviders);
  const requested = String(orderText)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const known = [];
  for (const name of requested) {
    if (existingProviders[name] && !known.includes(name)) {
      known.push(name);
    }
  }

  for (const fallback of Object.keys(existingProviders)) {
    if (!known.includes(fallback)) known.push(fallback);
  }

  return known;
}

function extractDomainFromGoal(goal) {
  const urlMatch = goal.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    try {
      return new URL(urlMatch[0]).hostname;
    } catch (error) {
      return null;
    }
  }
  const domainLike = goal.match(/\b([a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i);
  return domainLike ? domainLike[0].replace(/\/$/, "") : null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

class ErrorLedger {
  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  record(type, message, extra = {}) {
    const entry = {
      at: new Date().toISOString(),
      type,
      message,
      ...extra
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  latest(limit = 50) {
    return this.entries.slice(-Math.max(1, limit));
  }

  summary() {
    const totals = {};
    for (const entry of this.entries) {
      totals[entry.type] = (totals[entry.type] || 0) + 1;
    }
    return {
      total: this.entries.length,
      totals
    };
  }
}

class KeyManager {
  constructor() {
    this.settings = deepClone(DEFAULT_SETTINGS);
    this.keyIndexByProvider = {};
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const stored = result[SETTINGS_STORAGE_KEY];
    if (stored && typeof stored === "object") {
      this.settings = this.mergeSettings(stored);
    }
    this.loaded = true;
  }

  mergeSettings(candidate) {
    const merged = deepClone(DEFAULT_SETTINGS);
    if (candidate.providerOrder && Array.isArray(candidate.providerOrder)) {
      merged.providerOrder = candidate.providerOrder.filter(Boolean);
    }
    if (candidate.providers && typeof candidate.providers === "object") {
      for (const [providerName, providerValue] of Object.entries(candidate.providers)) {
        if (!merged.providers[providerName]) {
          merged.providers[providerName] = {
            endpoint: "",
            reasoningModel: "",
            visionModel: "",
            apiKeys: [],
            requiresKey: true,
            supportsJsonMode: true
          };
        }
        merged.providers[providerName] = {
          ...merged.providers[providerName],
          ...providerValue,
          apiKeys: parseLineSeparatedKeys(providerValue.apiKeys)
        };
      }
    }
    merged.providerOrder = normalizeProviderOrder(
      merged.providerOrder.join(","),
      merged.providers
    );
    return merged;
  }

  async save() {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: this.settings
    });
  }

  getProviderOrder() {
    return this.settings.providerOrder.slice();
  }

  getProvider(name) {
    return this.settings.providers[name] || null;
  }

  getCurrentKeyInfo(providerName) {
    const provider = this.getProvider(providerName);
    if (!provider || !provider.requiresKey) return { key: null, index: 0, count: 0 };
    const keys = provider.apiKeys || [];
    if (!keys.length) return { key: null, index: 0, count: 0 };
    const currentIndex = (this.keyIndexByProvider[providerName] || 0) % keys.length;
    return {
      key: keys[currentIndex],
      index: currentIndex,
      count: keys.length
    };
  }

  rotateKey(providerName) {
    const provider = this.getProvider(providerName);
    if (!provider || !provider.requiresKey) return;
    const keys = provider.apiKeys || [];
    if (!keys.length) return;
    const current = this.keyIndexByProvider[providerName] || 0;
    this.keyIndexByProvider[providerName] = (current + 1) % keys.length;
  }

  async updateProviderSettings(payload) {
    await this.load();
    const providerName = (payload.providerName || "").trim();
    if (!providerName) {
      throw new Error("providerName is required for provider update.");
    }

    if (!this.settings.providers[providerName]) {
      this.settings.providers[providerName] = {
        endpoint: "",
        reasoningModel: "",
        visionModel: "",
        apiKeys: [],
        requiresKey: true,
        supportsJsonMode: true
      };
    }

    const provider = this.settings.providers[providerName];
    if (payload.endpoint) provider.endpoint = String(payload.endpoint).trim();
    if (payload.reasoningModel) provider.reasoningModel = String(payload.reasoningModel).trim();
    if (payload.visionModel) provider.visionModel = String(payload.visionModel).trim();
    if (payload.supportsJsonMode !== undefined) provider.supportsJsonMode = Boolean(payload.supportsJsonMode);

    if (payload.requiresKey !== undefined) {
      provider.requiresKey = Boolean(payload.requiresKey);
    } else if (payload.endpoint) {
      provider.requiresKey = !provider.endpoint.includes("localhost");
    }

    if (payload.keys !== undefined || payload.apiKeys !== undefined || payload.keysText !== undefined) {
      const source = payload.keys !== undefined
        ? payload.keys
        : (payload.apiKeys !== undefined ? payload.apiKeys : payload.keysText);
      provider.apiKeys = parseLineSeparatedKeys(source);
      this.keyIndexByProvider[providerName] = 0;
    }

    if (payload.providerOrderText || payload.providerOrder) {
      const orderText = payload.providerOrderText || payload.providerOrder;
      this.settings.providerOrder = normalizeProviderOrder(
        Array.isArray(orderText) ? orderText.join(",") : orderText,
        this.settings.providers
      );
    } else if (!this.settings.providerOrder.includes(providerName)) {
      this.settings.providerOrder.unshift(providerName);
    }

    await this.save();
    return this.getSettingsForUi();
  }

  async getSettingsForUi() {
    await this.load();
    return deepClone(this.settings);
  }
}

class ProviderRouter {
  constructor(keyManager, ledger) {
    this.keyManager = keyManager;
    this.ledger = ledger;
  }

  async call(options) {
    const {
      mode,
      messages,
      jsonMode = true,
      temperature = 0.1,
      maxTokens = 1200,
      imageData = null
    } = options;

    await this.keyManager.load();

    const providerOrder = this.keyManager.getProviderOrder();
    let lastError = null;

    for (const providerName of providerOrder) {
      const provider = this.keyManager.getProvider(providerName);
      if (!provider || !provider.endpoint) continue;

      const maxAttempts = provider.requiresKey
        ? Math.max(1, (provider.apiKeys || []).length)
        : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const keyInfo = this.keyManager.getCurrentKeyInfo(providerName);
        if (provider.requiresKey && !keyInfo.key) {
          this.ledger.record("provider", "Missing API key for provider.", {
            providerName
          });
          break;
        }

        try {
          const startedAt = performance.now();
          const parsed = await this.callProvider({
            providerName,
            provider,
            mode,
            messages,
            imageData,
            jsonMode,
            temperature,
            maxTokens,
            apiKey: keyInfo.key
          });
          this.ledger.record("latency", "Provider call completed.", {
            providerName,
            mode,
            latencyMs: Math.round(performance.now() - startedAt)
          });
          return parsed;
        } catch (error) {
          lastError = error;
          this.ledger.record("provider", error.message, {
            providerName,
            mode,
            attempt
          });

          if (String(error.message).includes("429")) {
            this.keyManager.rotateKey(providerName);
            continue;
          }

          if (provider.requiresKey && String(error.message).includes("401")) {
            this.keyManager.rotateKey(providerName);
            continue;
          }

          break;
        }
      }
    }

    throw lastError || new Error("No provider could satisfy the request.");
  }

  buildVisionPayloadMessages(messages, imageData) {
    const systemParts = [];
    const userParts = [];

    for (const message of messages) {
      const content = typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
      if (message.role === "system") systemParts.push(content);
      else userParts.push(content);
    }

    const payload = [];
    if (systemParts.length) {
      payload.push({
        role: "system",
        content: systemParts.join("\n\n")
      });
    }
    payload.push({
      role: "user",
      content: [
        { type: "text", text: userParts.join("\n\n") || "Analyze this screenshot." },
        { type: "image_url", image_url: { url: imageData } }
      ]
    });

    return payload;
  }

  async callProvider(args) {
    const {
      providerName,
      provider,
      mode,
      messages,
      imageData,
      jsonMode,
      temperature,
      maxTokens,
      apiKey
    } = args;

    const model = mode === "vision" ? provider.visionModel : provider.reasoningModel;
    if (!model) {
      throw new Error("Provider " + providerName + " has no model mapped for mode " + mode + ".");
    }

    const payloadMessages = imageData
      ? this.buildVisionPayloadMessages(messages, imageData)
      : messages;

    const body = {
      model,
      messages: payloadMessages,
      temperature,
      max_tokens: maxTokens
    };

    if (jsonMode && provider.supportsJsonMode !== false) {
      body.response_format = { type: "json_object" };
    }

    const headers = {
      "Content-Type": "application/json"
    };
    if (provider.requiresKey && apiKey) {
      headers.Authorization = "Bearer " + apiKey;
    }

    const response = await fetch(provider.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error("Provider " + providerName + " failed (" + response.status + "): " + compact(text, 220));
    }

    const data = await response.json();
    const messageContent = data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (jsonMode) {
      if (Array.isArray(messageContent)) {
        const joined = messageContent.map((part) => part.text || "").join("\n");
        return safeParseJSON(joined);
      }
      return safeParseJSON(messageContent || "{}");
    }

    if (Array.isArray(messageContent)) {
      return messageContent.map((part) => part.text || "").join("\n");
    }
    return messageContent;
  }
}

class TaskGraph {
  constructor(goal, tasks) {
    this.goal = goal;
    this.tasks = (tasks || []).map((task) => ({
      id: task.id,
      type: task.type,
      input: task.input || {},
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.slice() : [],
      status: task.status || "pending",
      output: task.output || null,
      error: task.error || null
    }));
    this.validate();
  }

  validate() {
    const ids = new Set();
    for (const task of this.tasks) {
      if (!task.id) throw new Error("Task id is required.");
      if (ids.has(task.id)) throw new Error("Duplicate task id detected: " + task.id);
      ids.add(task.id);
    }

    for (const task of this.tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) {
          throw new Error("Task dependency missing: " + task.id + " depends on " + dep);
        }
      }
    }

    const visiting = new Set();
    const visited = new Set();
    const adjacency = new Map(this.tasks.map((task) => [task.id, task.dependsOn.slice()]));

    const dfs = (taskId) => {
      if (visiting.has(taskId)) {
        throw new Error("TaskGraph cycle detected at task " + taskId);
      }
      if (visited.has(taskId)) return;
      visiting.add(taskId);
      const deps = adjacency.get(taskId) || [];
      for (const dep of deps) dfs(dep);
      visiting.delete(taskId);
      visited.add(taskId);
    };

    for (const task of this.tasks) {
      dfs(task.id);
    }
  }

  getTask(id) {
    return this.tasks.find((task) => task.id === id) || null;
  }

  getNextReadyTask() {
    for (const task of this.tasks) {
      if (task.status !== "pending") continue;
      let ready = true;
      for (const depId of task.dependsOn) {
        const dep = this.getTask(depId);
        if (!dep || dep.status !== "completed") {
          ready = false;
          break;
        }
      }
      if (ready) return task;
    }
    return null;
  }

  hasPendingTasks() {
    return this.tasks.some((task) => task.status === "pending");
  }

  markCompleted(taskId, output) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Cannot mark missing task completed: " + taskId);
    task.status = "completed";
    task.output = output || null;
    task.error = null;
  }

  markFailed(taskId, error) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Cannot mark missing task failed: " + taskId);
    task.status = "failed";
    task.error = String(error && error.message ? error.message : error);
  }

  dropPendingTasks(reason) {
    for (const task of this.tasks) {
      if (task.status === "pending") {
        task.status = "dropped";
        task.error = reason || "Dropped by replanning.";
      }
    }
  }

  addTasks(newTasks) {
    const normalized = (newTasks || []).map((task) => ({
      id: task.id,
      type: task.type,
      input: task.input || {},
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.slice() : [],
      status: "pending",
      output: null,
      error: null
    }));
    this.tasks.push(...normalized);
    this.validate();
  }

  plannerContext() {
    return {
      completed: this.tasks
        .filter((task) => task.status === "completed")
        .map((task) => ({ id: task.id, type: task.type })),
      failed: this.tasks
        .filter((task) => task.status === "failed")
        .map((task) => ({ id: task.id, type: task.type, error: task.error })),
      dropped: this.tasks
        .filter((task) => task.status === "dropped")
        .map((task) => ({ id: task.id, type: task.type, error: task.error }))
    };
  }
}

class TaskPlanner {
  constructor(router, ledger) {
    this.router = router;
    this.ledger = ledger;
  }

  async buildTaskGraph(goal, stateContext) {
    const llmAttempt = await this.tryLlmPlan(goal, stateContext);
    if (llmAttempt && llmAttempt.tasks && llmAttempt.tasks.length) {
      return new TaskGraph(goal, llmAttempt.tasks);
    }
    return this.fallbackTaskGraph(goal);
  }

  async tryLlmPlan(goal, stateContext) {
    try {
      const messages = [
        {
          role: "system",
          content: [
            "You are task-planner. Build a Directed Acyclic Graph (DAG) TaskGraph for a browser agent.",
            "Output JSON only with format: {\"tasks\":[{\"id\":\"t1\",\"type\":\"navigate|extract|reason|act|verify|compare_tabs|done\",\"input\":{},\"dependsOn\":[]}]}",
            "Rules:",
            "1. Every task id must be unique.",
            "2. dependsOn must reference prior tasks only.",
            "3. Use atomic browser-executable steps.",
            "4. End with a done task."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            goal,
            stateContext
          })
        }
      ];

      const result = await this.router.call({
        mode: "reasoning",
        messages,
        jsonMode: true,
        temperature: 0.05,
        maxTokens: 1100
      });

      if (!result || !Array.isArray(result.tasks)) {
        return null;
      }

      const tasks = result.tasks
        .map((task, index) => ({
          id: String(task.id || "t" + (index + 1)),
          type: String(task.type || "").toLowerCase().trim(),
          input: task.input && typeof task.input === "object" ? task.input : {},
          dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []
        }))
        .filter((task) => task.type);

      if (!tasks.length) return null;
      return { tasks };
    } catch (error) {
      this.ledger.record("planner", "LLM planning failed, falling back.", {
        error: String(error && error.message ? error.message : error)
      });
      return null;
    }
  }

  fallbackTaskGraph(goal) {
    let counter = 1;
    const tasks = [];
    const addTask = (type, input, dependsOn) => {
      const id = "t" + counter;
      counter += 1;
      tasks.push({
        id,
        type,
        input: input || {},
        dependsOn: dependsOn || []
      });
      return id;
    };

    const urlMatch = goal.match(/https?:\/\/[^\s]+/i);
    const domainLike = extractDomainFromGoal(goal);
    const compareRequested = /compare|cheapest|lowest|best\s+price|across\s+tabs/i.test(goal);

    let navigateTarget = "https://www.google.com/";
    if (urlMatch) navigateTarget = urlMatch[0];
    else if (domainLike && domainLike.includes(".")) navigateTarget = domainLike;

    const navigateTask = addTask("navigate", { target: navigateTarget }, []);

    let preReasonDependency = navigateTask;

    if (!urlMatch) {
      const typeTask = addTask("act", {
        forcedAction: {
          action: "type",
          targetHint: "search",
          text: goal,
          reason: "Populate search box with objective."
        }
      }, [navigateTask]);

      const pressTask = addTask("act", {
        forcedAction: {
          action: "press",
          targetHint: "search",
          key: "Enter",
          reason: "Submit search query."
        }
      }, [typeTask]);

      preReasonDependency = pressTask;
    }

    const extractTask = addTask("extract", { softLimitTokens: DEFAULT_SOFT_LIMIT_TOKENS }, [preReasonDependency]);
    preReasonDependency = extractTask;

    if (compareRequested) {
      const compareTask = addTask("compare_tabs", { mode: "cheapest" }, [extractTask]);
      preReasonDependency = compareTask;
    }

    const reasonTask = addTask("reason", { goal }, [preReasonDependency]);
    const actTask = addTask("act", {}, [reasonTask]);
    const verifyTask = addTask("verify", { goal }, [actTask]);
    addTask("done", {}, [verifyTask]);

    return new TaskGraph(goal, tasks);
  }

  async buildPivotGraph(goal, block, stateContext) {
    const llmPivot = await this.tryLlmPivot(goal, block, stateContext);
    if (llmPivot && llmPivot.tasks && llmPivot.tasks.length) {
      return new TaskGraph(goal, llmPivot.tasks);
    }

    const pivotPrefix = "p" + Date.now();
    const tasks = [
      {
        id: pivotPrefix + "_extract",
        type: "extract",
        input: { softLimitTokens: DEFAULT_SOFT_LIMIT_TOKENS },
        dependsOn: []
      },
      {
        id: pivotPrefix + "_reason",
        type: "reason",
        input: {
          goal,
          block
        },
        dependsOn: [pivotPrefix + "_extract"]
      },
      {
        id: pivotPrefix + "_act",
        type: "act",
        input: {},
        dependsOn: [pivotPrefix + "_reason"]
      },
      {
        id: pivotPrefix + "_verify",
        type: "verify",
        input: { goal },
        dependsOn: [pivotPrefix + "_act"]
      },
      {
        id: pivotPrefix + "_done",
        type: "done",
        input: {},
        dependsOn: [pivotPrefix + "_verify"]
      }
    ];

    if (/not found|missing|blocked|obstructed/i.test(String(block && block.reason || ""))) {
      tasks.splice(1, 0, {
        id: pivotPrefix + "_scroll_probe",
        type: "act",
        input: {
          forcedAction: {
            action: "scroll",
            deltaY: 360,
            reason: "Probe deeper viewport due block."
          }
        },
        dependsOn: [pivotPrefix + "_extract"]
      });
      tasks[2].dependsOn = [pivotPrefix + "_scroll_probe"];
    }

    return new TaskGraph(goal, tasks);
  }

  async tryLlmPivot(goal, block, stateContext) {
    try {
      const messages = [
        {
          role: "system",
          content: [
            "You are task-planner dynamic replan engine.",
            "A block occurred. Build an alternative DAG route to continue progress.",
            "Output JSON only: {\"tasks\":[{\"id\":\"...\",\"type\":\"extract|reason|act|verify|done|compare_tabs|navigate\",\"input\":{},\"dependsOn\":[]}]}.",
            "Do not produce loops."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            goal,
            block,
            stateContext
          })
        }
      ];

      const result = await this.router.call({
        mode: "reasoning",
        messages,
        jsonMode: true,
        temperature: 0.2,
        maxTokens: 1100
      });

      if (!result || !Array.isArray(result.tasks) || !result.tasks.length) {
        return null;
      }

      return {
        tasks: result.tasks
          .map((task, index) => ({
            id: String(task.id || "p" + Date.now() + "_" + (index + 1)),
            type: String(task.type || "").toLowerCase().trim(),
            input: task.input && typeof task.input === "object" ? task.input : {},
            dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []
          }))
          .filter((task) => task.type)
      };
    } catch (error) {
      this.ledger.record("planner", "LLM pivot failed, using fallback pivot.", {
        error: String(error && error.message ? error.message : error)
      });
      return null;
    }
  }
}

class NavigationController {
  constructor(ledger) {
    this.ledger = ledger;
  }

  normalizeTarget(rawTarget, goal) {
    const target = (rawTarget || "").trim();

    if (!target) {
      return "https://www.google.com/search?q=" + encodeURIComponent(goal || "");
    }

    if (target === "/back" || target === "back") return "/back";
    if (target === "/forward" || target === "forward") return "/forward";

    if (/^https?:\/\//i.test(target)) return target;
    if (/^localhost(?::\d+)?/i.test(target)) return "http://" + target;

    const hasWhitespace = /\s/.test(target);
    const looksLikeDomain = /([a-z0-9-]+\.)+[a-z]{2,}/i.test(target);

    if (hasWhitespace && !looksLikeDomain) {
      return "https://www.google.com/search?q=" + encodeURIComponent(target);
    }

    if (looksLikeDomain) return "https://" + target;
    return "https://www.google.com/search?q=" + encodeURIComponent(target);
  }

  async emitBurst(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "SHOW_RENDER_BURST" });
    } catch (error) {
      // Ignore if content script is unavailable.
    }
  }

  async navigate(tabId, rawTarget, goal) {
    const normalized = this.normalizeTarget(rawTarget, goal);
    if (normalized === "/back") return this.goBack(tabId);
    if (normalized === "/forward") return this.goForward(tabId);

    await this.emitBurst(tabId);
    await chrome.tabs.update(tabId, { url: normalized });
    await waitForTabComplete(tabId, 18000);

    return {
      action: "navigate",
      url: normalized
    };
  }

  async goBack(tabId) {
    await this.emitBurst(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: function () {
        history.back();
      }
    });
    await waitForTabComplete(tabId, 12000);
    return { action: "back" };
  }

  async goForward(tabId) {
    await this.emitBurst(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: function () {
        history.forward();
      }
    });
    await waitForTabComplete(tabId, 12000);
    return { action: "forward" };
  }
}

class VisionEngine {
  constructor(router, ledger) {
    this.router = router;
    this.ledger = ledger;
    this.lastCapture = {
      tabId: null,
      at: 0,
      dataUrl: null
    };
  }

  async capture(tab) {
    const now = Date.now();
    if (
      this.lastCapture.tabId === tab.id &&
      now - this.lastCapture.at <= 200 &&
      this.lastCapture.dataUrl
    ) {
      return {
        dataUrl: this.lastCapture.dataUrl,
        cached: true
      };
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 65
    });

    this.lastCapture = {
      tabId: tab.id,
      at: now,
      dataUrl
    };

    return {
      dataUrl,
      cached: false
    };
  }

  normalizeCoordinates(raw, viewport) {
    const width = viewport && viewport.width ? viewport.width : 1280;
    const height = viewport && viewport.height ? viewport.height : 720;

    let x = numberOrNull(raw.x);
    let y = numberOrNull(raw.y);

    if (x == null && numberOrNull(raw.cx) != null) x = numberOrNull(raw.cx);
    if (y == null && numberOrNull(raw.cy) != null) y = numberOrNull(raw.cy);

    if (x == null || y == null) return null;

    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      x = Math.round(x * width);
      y = Math.round(y * height);
    }

    x = Math.max(0, Math.min(width - 1, Math.round(x)));
    y = Math.max(0, Math.min(height - 1, Math.round(y)));

    return {
      x,
      y,
      confidence: numberOrNull(raw.confidence) == null ? 0.5 : numberOrNull(raw.confidence),
      reason: raw.reason || "Vision-inferred target."
    };
  }

  async locateTarget(tab, goal, snapshot) {
    const capture = await this.capture(tab);
    const viewport = snapshot && snapshot.viewport ? snapshot.viewport : null;

    const messages = [
      {
        role: "system",
        content: [
          "You are agent-vision fallback.",
          "The DOM extraction was obstructed and found too few interactive targets.",
          "Return strict JSON only: {\"x\":<number>,\"y\":<number>,\"confidence\":0-1,\"reason\":\"...\"}.",
          "Coordinates may be absolute pixels or normalized [0..1]."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          goal,
          url: snapshot && snapshot.url,
          title: snapshot && snapshot.title,
          visibleInteractiveCount: snapshot && snapshot.elements ? snapshot.elements.length : 0
        })
      }
    ];

    const result = await this.router.call({
      mode: "vision",
      messages,
      imageData: capture.dataUrl,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 500
    });

    const normalized = this.normalizeCoordinates(result, viewport);
    if (!normalized) {
      throw new Error("Vision model did not return usable coordinates.");
    }

    this.ledger.record("vision", "Vision fallback coordinate resolved.", {
      cachedCapture: capture.cached,
      confidence: normalized.confidence
    });

    return normalized;
  }
}

class TabComparator {
  parsePrice(text) {
    if (!text) return null;
    const match = String(text).replace(/,/g, "").match(/([$€£])\s?(\d+(?:\.\d{1,2})?)/);
    if (!match) return null;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) return null;
    return {
      value,
      currency: match[1]
    };
  }

  interleave(snapshots) {
    const rows = [];
    const columns = ["tabId", "nodeId", "text", "priceValue", "currency", "x", "y", "url", "title"];

    for (const snapshot of snapshots) {
      const tab = snapshot.tab;
      const page = snapshot.snapshot || snapshot;
      const elements = page && page.elements ? page.elements : [];
      for (const element of elements) {
        const parsed = this.parsePrice(element.text || element.description || "");
        rows.push({
          tabId: tab.id,
          nodeId: String(tab.id) + ":" + String(element.elementId || element.nodeId || "n/a"),
          elementId: element.elementId || element.nodeId || null,
          text: compact(element.text || element.description || "", 120),
          priceValue: parsed ? parsed.value : null,
          currency: parsed ? parsed.currency : null,
          x: element.x,
          y: element.y,
          url: page.url,
          title: page.title
        });
      }
    }

    return {
      columns,
      rows,
      compressedCellCount: rows.length * columns.length
    };
  }

  pickCheapest(interleaved) {
    const priced = interleaved.rows.filter((row) => Number.isFinite(row.priceValue));
    if (!priced.length) return null;
    priced.sort((a, b) => a.priceValue - b.priceValue);
    return priced[0];
  }
}

class AgentInstance {
  constructor(tabId, goal) {
    this.tabId = tabId;
    this.goal = goal;
    this.createdAt = Date.now();
    this.memory = {
      completed: [],
      failed: []
    };
  }
}

class SwarmManager {
  constructor(agentCore, comparator, ledger) {
    this.agentCore = agentCore;
    this.comparator = comparator;
    this.ledger = ledger;
    this.instances = new Map();
  }

  ensureInstances(tabs, goal) {
    for (const tab of tabs) {
      if (!this.instances.has(tab.id)) {
        this.instances.set(tab.id, new AgentInstance(tab.id, goal));
      }
    }
  }

  async compareAndAct(goal) {
    const candidateTabs = await chrome.tabs.query({ currentWindow: true });
    const tabs = candidateTabs
      .filter((tab) => /^https?:/i.test(tab.url || ""))
      .slice(0, MAX_SWARM_TABS);

    if (tabs.length < 2) {
      throw new Error("Swarm compare needs at least 2 HTTP(S) tabs in current window.");
    }

    this.ensureInstances(tabs, goal);

    const snapshots = [];
    for (const tab of tabs) {
      const snapshot = await this.agentCore.extractPageState(tab.id, {
        softLimitTokens: 1200,
        allowVisionFallback: false
      }, goal);
      snapshots.push({ tab, snapshot });
    }

    const interleaved = this.comparator.interleave(snapshots);
    const winner = this.comparator.pickCheapest(interleaved);

    if (winner) {
      await this.agentCore.executeDirectAction(winner.tabId, {
        action: "click",
        elementId: winner.elementId,
        x: winner.x,
        y: winner.y,
        reason: "Swarm winner node selected by cheapest price."
      });
    }

    this.ledger.record("swarm", "Swarm compare completed.", {
      tabCount: tabs.length,
      rowCount: interleaved.rows.length,
      winnerNode: winner ? winner.nodeId : null
    });

    return {
      totalTabs: tabs.length,
      interleaved,
      winner
    };
  }
}

class AgentCore {
  constructor(planner, router, navigationController, visionEngine, ledger) {
    this.planner = planner;
    this.router = router;
    this.navigationController = navigationController;
    this.visionEngine = visionEngine;
    this.ledger = ledger;
    this.swarmManager = null;
    this.resetRuntime();
  }

  setSwarmManager(swarmManager) {
    this.swarmManager = swarmManager;
  }

  resetRuntime() {
    this.isRunning = false;
    this.goal = "";
    this.activeTabId = null;
    this.failureStreak = 0;
    this.graph = null;
    this.stateMemory = {
      completed: [],
      failed: [],
      blocks: [],
      lastSnapshot: null,
      lastReasoning: null,
      lastAction: null
    };
  }

  buildPlannerStateContext() {
    return {
      goal: this.goal,
      completed: this.stateMemory.completed.slice(-MAX_CONTEXT_ACTIONS),
      failed: this.stateMemory.failed.slice(-MAX_CONTEXT_ACTIONS),
      blocks: this.stateMemory.blocks.slice(-MAX_CONTEXT_ACTIONS),
      graph: this.graph ? this.graph.plannerContext() : { completed: [], failed: [], dropped: [] }
    };
  }

  async start(goal, tabId) {
    if (this.isRunning) {
      throw new Error("Agent is already running.");
    }

    this.resetRuntime();
    this.goal = (goal || "").trim();
    if (!this.goal) {
      throw new Error("Task goal cannot be empty.");
    }

    const active = tabId ? { id: tabId } : await getActiveTab();
    if (!active || !active.id) {
      throw new Error("No active tab found.");
    }
    this.activeTabId = active.id;
    this.isRunning = true;

    this.graph = await this.planner.buildTaskGraph(this.goal, this.buildPlannerStateContext());

    emitStatus(
      "TaskGraph created with " + this.graph.tasks.length + " tasks.",
      "sys",
      this.activeTabId
    );

    try {
      await this.runLoop();
    } finally {
      this.isRunning = false;
    }
  }

  stop(reason) {
    if (!this.isRunning) return;
    this.isRunning = false;
    emitStatus(reason || "Agent stopped.", "error", this.activeTabId);
  }

  async runLoop() {
    while (this.isRunning) {
      if (this.failureStreak >= LOOP_FAILURE_CAP) {
        this.ledger.record("safety", "Loop failure cap reached.", {
          failureStreak: this.failureStreak
        });
        this.stop("Safety stop: hit 50 consecutive failures.");
        return;
      }

      const nextTask = this.graph.getNextReadyTask();
      if (!nextTask) {
        if (this.graph.hasPendingTasks()) {
          await this.handleBlock({
            reason: "Scheduler found no ready tasks while pending tasks remain.",
            stage: "scheduler"
          }, null);
          await sleep(250);
          continue;
        }
        emitStatus("No pending tasks remain.", "success", this.activeTabId);
        this.isRunning = false;
        return;
      }

      emitStatus(
        "Executing " + nextTask.id + " (" + nextTask.type + ")",
        "info",
        this.activeTabId
      );

      const startedAt = performance.now();

      try {
        const output = await this.executeTask(nextTask);
        this.graph.markCompleted(nextTask.id, output);
        this.failureStreak = 0;
        this.stateMemory.completed.push({
          taskId: nextTask.id,
          type: nextTask.type,
          output: compact(output, 240)
        });
        if (this.stateMemory.completed.length > MAX_CONTEXT_ACTIONS) {
          this.stateMemory.completed.shift();
        }
        this.ledger.record("latency", "Task completed.", {
          taskId: nextTask.id,
          taskType: nextTask.type,
          latencyMs: Math.round(performance.now() - startedAt)
        });
      } catch (error) {
        this.failureStreak += 1;
        this.graph.markFailed(nextTask.id, error);
        const reason = String(error && error.message ? error.message : error);

        this.stateMemory.failed.push({
          taskId: nextTask.id,
          type: nextTask.type,
          reason
        });
        if (this.stateMemory.failed.length > MAX_CONTEXT_ACTIONS) {
          this.stateMemory.failed.shift();
        }

        this.ledger.record("execution", "Task execution failed.", {
          taskId: nextTask.id,
          taskType: nextTask.type,
          reason,
          latencyMs: Math.round(performance.now() - startedAt)
        });

        await this.handleBlock({
          reason,
          taskId: nextTask.id,
          taskType: nextTask.type
        }, nextTask);
      }

      await sleep(200);
    }
  }

  async handleBlock(block, failedTask) {
    this.stateMemory.blocks.push({
      at: new Date().toISOString(),
      ...block
    });
    if (this.stateMemory.blocks.length > MAX_CONTEXT_ACTIONS) {
      this.stateMemory.blocks.shift();
    }

    emitStatus(
      "Block detected: " + compact(block.reason || "unknown", 140),
      "error",
      this.activeTabId
    );

    if (!this.graph) return;

    this.graph.dropPendingTasks("Dropped due block: " + (block.reason || "unknown"));
    const pivot = await this.planner.buildPivotGraph(
      this.goal,
      block,
      this.buildPlannerStateContext()
    );

    if (!pivot || !pivot.tasks.length) {
      if (failedTask) {
        throw new Error("Unable to build pivot graph after block.");
      }
      return;
    }

    this.graph.addTasks(pivot.tasks);
    emitStatus(
      "Pivot injected with " + pivot.tasks.length + " tasks.",
      "sys",
      this.activeTabId
    );
  }

  async executeTask(task) {
    switch (task.type) {
      case "navigate":
        return this.navigationController.navigate(
          this.activeTabId,
          task.input.target || task.input.url || "",
          this.goal
        );

      case "extract":
        return this.extractPageState(
          this.activeTabId,
          task.input || {},
          this.goal
        );

      case "reason": {
        const action = await this.planAction(task.input || {});
        this.stateMemory.lastReasoning = action;
        return action;
      }

      case "act": {
        const action = task.input && task.input.forcedAction
          ? task.input.forcedAction
          : this.stateMemory.lastReasoning;
        if (!action) {
          throw new Error("No action available for act task.");
        }
        const response = await this.executeDirectAction(this.activeTabId, action);
        this.stateMemory.lastAction = action;
        return response;
      }

      case "verify": {
        const verification = await this.verifyGoal(task.input || {});
        if (!verification.isDone) {
          throw new Error("Goal not complete: " + (verification.reason || "verification failed"));
        }
        return verification;
      }

      case "compare_tabs": {
        if (!this.swarmManager) throw new Error("SwarmManager is not configured.");
        return this.swarmManager.compareAndAct(this.goal);
      }

      case "done":
        this.isRunning = false;
        emitStatus("Goal completed.", "success", this.activeTabId);
        return { done: true };

      default:
        throw new Error("Unknown task type: " + task.type);
    }
  }

  async ensureContentScript(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PING" });
      return;
    } catch (error) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      await sleep(150);
    }
  }

  resolveElementFromAction(action, snapshot) {
    const elements = snapshot && snapshot.elements ? snapshot.elements : [];
    if (!elements.length) return null;

    if (action.elementId) {
      const exact = elements.find((item) => item.elementId === action.elementId);
      if (exact) return exact;
    }

    const indexRaw = action.elementIndex;
    const index = (indexRaw === null || indexRaw === undefined || indexRaw === "")
      ? NaN
      : Number(indexRaw);
    if (Number.isFinite(index) && index >= 0 && index < elements.length) {
      return elements[index];
    }

    const hint = String(action.targetHint || "").toLowerCase().trim();
    if (hint) {
      const byHint = elements.find((item) => {
        const hay = (item.text || item.description || "").toLowerCase();
        return hay.includes(hint);
      });
      if (byHint) return byHint;
    }

    const reason = String(action.reason || "").toLowerCase().trim();
    if (reason) {
      const byReason = elements.find((item) => {
        const hay = (item.text || item.description || "").toLowerCase();
        return hay.includes("search") && reason.includes("search");
      });
      if (byReason) return byReason;
    }

    return elements[0];
  }

  normalizeAction(rawAction, snapshot) {
    if (!rawAction || typeof rawAction !== "object") {
      return {
        action: "scroll",
        deltaY: 320,
        reason: "Fallback action because planner response was invalid."
      };
    }

    const action = String(rawAction.action || "").toLowerCase().trim();
    const normalized = {
      action: action || "scroll",
      text: rawAction.text || "",
      key: rawAction.key || "",
      url: rawAction.url || rawAction.target || "",
      elementId: rawAction.elementId || rawAction.nodeId || "",
      elementIndex: numberOrNull(rawAction.elementIndex),
      targetHint: rawAction.targetHint || "",
      reason: rawAction.reason || "",
      x: numberOrNull(rawAction.x),
      y: numberOrNull(rawAction.y),
      deltaY: numberOrNull(rawAction.deltaY),
      absolute: Boolean(rawAction.absolute)
    };

    if (normalized.action === "type" && !normalized.text && this.goal) {
      normalized.text = this.goal;
    }

    const resolvedElement = this.resolveElementFromAction(normalized, snapshot);
    if (resolvedElement) {
      if (!normalized.elementId) normalized.elementId = resolvedElement.elementId || "";
      if (normalized.x == null) normalized.x = numberOrNull(resolvedElement.x);
      if (normalized.y == null) normalized.y = numberOrNull(resolvedElement.y);
    }

    return normalized;
  }

  async planAction(taskInput) {
    const snapshot = this.stateMemory.lastSnapshot;
    if (!snapshot || !Array.isArray(snapshot.elements) || !snapshot.elements.length) {
      throw new Error("No page snapshot available for reasoning.");
    }

    const compactElements = snapshot.elements.slice(0, 80).map((element, index) => ({
      index,
      elementId: element.elementId,
      text: element.text,
      description: element.description,
      x: element.x,
      y: element.y
    }));

    const messages = [
      {
        role: "system",
        content: [
          "You are agent-core reasoning engine.",
          "Select one next browser action.",
          "Output JSON only: {\"action\":\"click|type|press|scroll|navigate|done\",\"elementId\":\"...\",\"elementIndex\":0,\"text\":\"\",\"key\":\"\",\"url\":\"\",\"x\":0,\"y\":0,\"deltaY\":300,\"reason\":\"...\"}.",
          "Use completed and failed memory to avoid loops and repeated failures."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          goal: this.goal,
          taskInput,
          url: snapshot.url,
          title: snapshot.title,
          completed: this.stateMemory.completed.slice(-10),
          failed: this.stateMemory.failed.slice(-10),
          blocks: this.stateMemory.blocks.slice(-5),
          elements: compactElements
        })
      }
    ];

    const raw = await this.router.call({
      mode: "reasoning",
      messages,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 1200
    });

    return this.normalizeAction(raw, snapshot);
  }

  async executeDirectAction(tabId, action) {
    const normalized = this.normalizeAction(action, this.stateMemory.lastSnapshot);

    if (normalized.action === "done") {
      this.isRunning = false;
      emitStatus("Model returned done action.", "success", tabId);
      return { done: true };
    }

    if (normalized.action === "navigate") {
      const target = normalized.url || normalized.targetHint || this.goal;
      return this.navigationController.navigate(tabId, target, this.goal);
    }

    if (normalized.action === "back") {
      return this.navigationController.goBack(tabId);
    }

    if (normalized.action === "forward") {
      return this.navigationController.goForward(tabId);
    }

    await this.ensureContentScript(tabId);

    const response = await chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_ACTION",
      action: normalized
    });

    if (!response || response.ok === false) {
      const message = response && response.error ? response.error : "Unknown content execution failure.";
      throw new Error("Action dispatch failed: " + message);
    }

    return response;
  }

  async extractPageState(tabId, options, goalOverride) {
    await this.ensureContentScript(tabId);

    const softLimitTokens = numberOrNull(options.softLimitTokens) || DEFAULT_SOFT_LIMIT_TOKENS;
    const allowVisionFallback = options.allowVisionFallback !== false;
    const snapshot = await chrome.tabs.sendMessage(tabId, {
      type: "EXTRACT_PAGE_STATE",
      options: {
        softLimitTokens
      }
    });

    if (!snapshot || snapshot.error) {
      throw new Error("DOM extraction failed: " + (snapshot && snapshot.error ? snapshot.error : "no response"));
    }

    const interactiveCount = Array.isArray(snapshot.elements) ? snapshot.elements.length : 0;
    const shouldFallback = snapshot.fallbackRecommended || interactiveCount < DOM_FALLBACK_THRESHOLD;

    if (shouldFallback && allowVisionFallback) {
      const tab = await chrome.tabs.get(tabId);
      emitStatus(
        "DOM obstruction detected (" + interactiveCount + " interactive nodes). Engaging vision fallback.",
        "error",
        tabId
      );

      try {
        const visual = await this.visionEngine.locateTarget(
          tab,
          goalOverride || this.goal,
          snapshot
        );

        snapshot.elements = snapshot.elements || [];
        snapshot.elements.unshift({
          elementId: "vision:" + Date.now(),
          description: "vision-target",
          text: visual.reason,
          x: visual.x,
          y: visual.y,
          score: 100,
          source: "vision"
        });
        snapshot.fallbackUsed = true;
      } catch (error) {
        this.ledger.record("vision", "Vision fallback failed.", {
          reason: String(error && error.message ? error.message : error)
        });
      }
    }

    this.stateMemory.lastSnapshot = snapshot;
    return snapshot;
  }

  async verifyGoal(taskInput) {
    const snapshot = this.stateMemory.lastSnapshot;
    if (!snapshot) {
      return {
        isDone: false,
        reason: "No snapshot available."
      };
    }

    const expectedDomain = extractDomainFromGoal(this.goal);
    if (expectedDomain && snapshot.url && snapshot.url.includes(expectedDomain)) {
      return {
        isDone: true,
        reason: "Current URL matches requested domain."
      };
    }

    const messages = [
      {
        role: "system",
        content: [
          "You are a verifier.",
          "Return JSON only: {\"isDone\":true|false,\"reason\":\"...\"}.",
          "Use goal, URL/title, and recent actions."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          goal: this.goal,
          taskInput,
          url: snapshot.url,
          title: snapshot.title,
          recentCompleted: this.stateMemory.completed.slice(-8),
          recentFailed: this.stateMemory.failed.slice(-5)
        })
      }
    ];

    try {
      const verdict = await this.router.call({
        mode: "reasoning",
        messages,
        jsonMode: true,
        temperature: 0.0,
        maxTokens: 320
      });

      return {
        isDone: Boolean(verdict.isDone),
        reason: verdict.reason || "Verification response received."
      };
    } catch (error) {
      this.ledger.record("verify", "Verification model call failed.", {
        reason: String(error && error.message ? error.message : error)
      });
      return {
        isDone: false,
        reason: "Verification call failed."
      };
    }
  }
}

const ledger = new ErrorLedger();
const keyManager = new KeyManager();
const router = new ProviderRouter(keyManager, ledger);
const planner = new TaskPlanner(router, ledger);
const navigationController = new NavigationController(ledger);
const visionEngine = new VisionEngine(router, ledger);
const comparator = new TabComparator();
const agentCore = new AgentCore(
  planner,
  router,
  navigationController,
  visionEngine,
  ledger
);
const swarmManager = new SwarmManager(agentCore, comparator, ledger);
agentCore.setSwarmManager(swarmManager);

function emitStatus(message, type = "info", tabId) {
  const msg = {
    type: "SIDEPANEL_LOG",
    message,
    msgType: type
  };

  chrome.runtime.sendMessage(msg).catch(function () {});

  const toTab = tabId || agentCore.activeTabId;
  if (toTab) {
    chrome.tabs.sendMessage(toTab, {
      type: "UPDATE_HUD",
      message,
      msgType: type
    }).catch(function () {});
  }

  console.log("[Comet][" + type + "] " + message);
}

async function bootstrap() {
  await keyManager.load();
  emitStatus("Provider settings loaded. BYOK routing active.", "sys");
}

chrome.sidePanel.setPanelBehavior({
  openPanelOnActionClick: true
}).catch(function (error) {
  console.warn("[Comet] Failed to set side panel behavior:", error);
});

chrome.commands.onCommand.addListener(function (command) {
  if (command !== "kill-switch") return;
  agentCore.stop("Kill-switch activated.");
  emitStatus("KILL-SWITCH ACTIVATED. Agent halted.", "error");
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    if (!msg || !msg.type) {
      sendResponse({ ok: false, error: "Missing message type." });
      return;
    }

    if (msg.type === "START_AGENT") {
      if (agentCore.isRunning) {
        sendResponse({ ok: false, error: "Agent is already running." });
        return;
      }
      const active = await getActiveTab();
      agentCore.start(msg.task, active ? active.id : null).catch(function (error) {
        ledger.record("runtime", "Agent run crashed.", {
          reason: String(error && error.message ? error.message : error)
        });
        emitStatus("Agent crashed: " + error.message, "error");
      });
      sendResponse({ ok: true, started: true });
      return;
    }

    if (msg.type === "STOP_AGENT") {
      agentCore.stop("Agent force stopped by user.");
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "RUN_SWARM_COMPARE") {
      const goal = (msg.task || "Find cheapest option across tabs.").trim();
      const result = await swarmManager.compareAndAct(goal);
      emitStatus(
        "Swarm interleaved " + result.totalTabs + " tabs and selected winner.",
        "success",
        agentCore.activeTabId
      );
      sendResponse({ ok: true, result: result });
      return;
    }

    if (msg.type === "SAVE_PROVIDER_SETTINGS") {
      const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : msg;
      const settings = await keyManager.updateProviderSettings(payload);
      emitStatus("Provider settings saved.", "success");
      sendResponse({ ok: true, settings: settings });
      return;
    }

    if (msg.type === "GET_PROVIDER_SETTINGS") {
      const settings = await keyManager.getSettingsForUi();
      sendResponse({ ok: true, settings: settings });
      return;
    }

    if (msg.type === "GET_LEDGER") {
      sendResponse({
        ok: true,
        entries: ledger.latest(msg.limit || 50),
        summary: ledger.summary()
      });
      return;
    }

    if (msg.type === "TEST_SCREENSHOT") {
      const tab = await getActiveTab();
      if (!tab) {
        sendResponse({ ok: false, error: "No active tab available." });
        return;
      }
      const capture = await visionEngine.capture(tab);
      sendResponse({
        ok: true,
        screenshotLength: capture.dataUrl.length,
        cached: capture.cached
      });
      return;
    }

    if (msg.type === "ALIVE_PING") {
      sendResponse({
        ok: true,
        now: Date.now()
      });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type: " + msg.type });
  })().catch(function (error) {
    const reason = String(error && error.message ? error.message : error);
    ledger.record("runtime", "Message handler failure.", {
      reason,
      messageType: msg && msg.type ? msg.type : "unknown"
    });
    emitStatus("Runtime error: " + reason, "error");
    sendResponse({ ok: false, error: reason });
  });

  return true;
});

bootstrap().catch(function (error) {
  const reason = String(error && error.message ? error.message : error);
  ledger.record("runtime", "Bootstrap failure.", { reason: reason });
  emitStatus("Bootstrap failure: " + reason, "error");
});