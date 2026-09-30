const taskInput = document.getElementById("taskInput");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const swarmBtn = document.getElementById("swarmBtn");
const testBtn = document.getElementById("testBtn");
const saveConfigBtn = document.getElementById("saveConfigBtn");

const providerSelect = document.getElementById("providerSelect");
const endpointInput = document.getElementById("endpointInput");
const reasoningModelInput = document.getElementById("reasoningModelInput");
const visionModelInput = document.getElementById("visionModelInput");
const apiKeysInput = document.getElementById("apiKeysInput");
const providerOrderInput = document.getElementById("providerOrderInput");

const logContainer = document.getElementById("logContainer");

let settingsCache = null;

function addLog(message, type = "info") {
  const row = document.createElement("div");
  row.className = "log-entry " + type;

  const stamp = document.createElement("span");
  stamp.className = "timestamp";
  stamp.textContent = "[" + new Date().toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }) + "]";

  const text = document.createElement("span");
  text.textContent = " " + message;

  row.appendChild(stamp);
  row.appendChild(text);
  logContainer.appendChild(row);

  logContainer.scrollTo({
    top: logContainer.scrollHeight,
    behavior: "smooth"
  });
}

function sendMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }
      resolve(response || { ok: false, error: "No response from background." });
    });
  });
}

function fillProviderSelect(settings) {
  providerSelect.innerHTML = "";
  const providerOrder = Array.isArray(settings.providerOrder)
    ? settings.providerOrder
    : Object.keys(settings.providers || {});

  for (const providerName of providerOrder) {
    if (!settings.providers[providerName]) continue;
    const option = document.createElement("option");
    option.value = providerName;
    option.textContent = providerName;
    providerSelect.appendChild(option);
  }

  if (!providerSelect.value && providerSelect.options.length) {
    providerSelect.value = providerSelect.options[0].value;
  }
}

function renderProviderFields(providerName) {
  if (!settingsCache || !settingsCache.providers) return;
  const provider = settingsCache.providers[providerName];
  if (!provider) return;

  endpointInput.value = provider.endpoint || "";
  reasoningModelInput.value = provider.reasoningModel || "";
  visionModelInput.value = provider.visionModel || "";
  apiKeysInput.value = Array.isArray(provider.apiKeys) ? provider.apiKeys.join("\n") : "";
  providerOrderInput.value = Array.isArray(settingsCache.providerOrder)
    ? settingsCache.providerOrder.join(",")
    : "";
}

async function loadProviderSettings() {
  const result = await sendMessage({ type: "GET_PROVIDER_SETTINGS" });
  if (!result.ok) {
    addLog("Failed to load provider settings: " + result.error, "error");
    return;
  }

  settingsCache = result.settings || { providers: {}, providerOrder: [] };
  fillProviderSelect(settingsCache);
  renderProviderFields(providerSelect.value);
  addLog("Provider settings loaded.", "sys");
}

providerSelect.addEventListener("change", () => {
  renderProviderFields(providerSelect.value);
});

startBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    addLog("Task input cannot be empty.", "error");
    return;
  }

  const result = await sendMessage({
    type: "START_AGENT",
    task
  });

  if (!result.ok) {
    addLog("Start failed: " + result.error, "error");
    return;
  }

  addLog("Agent started: \"" + task + "\"", "sys");
});

stopBtn.addEventListener("click", async () => {
  const result = await sendMessage({ type: "STOP_AGENT" });
  if (!result.ok) {
    addLog("Stop request failed: " + result.error, "error");
    return;
  }
  addLog("Stop request dispatched.", "sys");
});

swarmBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim() || "Find the cheapest option across open tabs.";
  addLog("Running swarm compare...", "sys");

  const result = await sendMessage({
    type: "RUN_SWARM_COMPARE",
    task
  });

  if (!result.ok) {
    addLog("Swarm compare failed: " + result.error, "error");
    return;
  }

  const winner = result.result && result.result.winner;
  if (winner) {
    const price = Number.isFinite(winner.priceValue)
      ? (winner.currency || "$") + winner.priceValue
      : "N/A";
    addLog("Swarm winner tab " + winner.tabId + " at " + price, "success");
  } else {
    addLog("Swarm completed, no priced winner found.", "info");
  }
});

testBtn.addEventListener("click", async () => {
  addLog("Testing screenshot capture...", "sys");
  const result = await sendMessage({ type: "TEST_SCREENSHOT" });
  if (!result.ok) {
    addLog("Screenshot test failed: " + result.error, "error");
    return;
  }
  addLog(
    "Screenshot OK (" + result.screenshotLength + " chars, cached=" + String(result.cached) + ")",
    "success"
  );
});

saveConfigBtn.addEventListener("click", async () => {
  const providerName = providerSelect.value.trim();
  if (!providerName) {
    addLog("Provider name is required.", "error");
    return;
  }

  const endpoint = endpointInput.value.trim();
  const payload = {
    providerName,
    endpoint,
    reasoningModel: reasoningModelInput.value.trim(),
    visionModel: visionModelInput.value.trim(),
    keysText: apiKeysInput.value,
    providerOrderText: providerOrderInput.value.trim(),
    requiresKey: endpoint ? !endpoint.includes("localhost") : undefined
  };

  const result = await sendMessage({
    type: "SAVE_PROVIDER_SETTINGS",
    payload
  });

  if (!result.ok) {
    addLog("Saving provider settings failed: " + result.error, "error");
    return;
  }

  settingsCache = result.settings;
  fillProviderSelect(settingsCache);
  providerSelect.value = providerName;
  renderProviderFields(providerName);
  addLog("Provider settings saved for " + providerName + ".", "success");
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "SIDEPANEL_LOG") return;
  addLog(msg.message || "", msg.msgType || "info");
});

setInterval(() => {
  sendMessage({ type: "ALIVE_PING" });
}, 10000);

loadProviderSettings();