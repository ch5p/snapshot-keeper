(() => {
  const SNAPSHOT_SECTIONS = [
    "### 현재 진행 중인 주제",
    "### 새로 확정된 사항",
    "### 미확정 사항",
    "### 제외된 주제 (1회 기록)",
    "### 앞으로 할 일"
  ];
  const STABILITY_MS = 2600;
  const PROCESSED_EVENT_TTL_MS = 10 * 60 * 1000;
  const PROCESSED_EVENT_LIMIT = 300;
  const DISMISSED_TOAST_TTL_MS = 30 * 60 * 1000;
  const DISMISSED_TOAST_LIMIT = 300;
  const PARSE_RETRY_DELAY_MS = 1500;
  const PARSE_RETRY_LIMIT = 80;
  const WAITING_DISPLAY_TTL_MS = 9000;
  const SETTINGS_DB_NAME = "snapshot-keeper-settings-db";
  const SETTINGS_STORE = "settings";
  const SAVE_DIRECTORY_HANDLE_KEY = "snapshot-save-directory-handle";
  const TURN_MARKDOWN_RE = /(?:^|\n)\s*##\s*turn\s*=\s*(\d+)\b/i;
  const TURN_RENDERED_RE = /(?:^|\n)\s*turn\s*=\s*(\d+)\b/i;
  const KOREA_TIME_RE = /대한민국 기준 시각:\s*\d{4}\.\d{2}\.\d{2}\([^)]+\)\s*\d{2}:\d{2}\s*$/u;
  const BAR_WATCHDOG_MS = 1500;
  const DEBUG = readDebugFlag();
  const SENT_EVENT_LABELS = {
    live: {
      invalid_snapshot: "[SK live] sent invalid_snapshot",
      missing_candidate: "[SK live] sent missing_candidate",
      snapshot_candidate: "[SK live] sent snapshot_candidate"
    },
    scan: {
      invalid_snapshot: "[SK scan] sent invalid_snapshot",
      missing_candidate: "[SK scan] sent missing_candidate",
      snapshot_candidate: "[SK scan] sent snapshot_candidate"
    }
  };

  const nodeBindings = new WeakMap();
  const nodeState = new WeakMap();
  const processedEvents = new Map();
  const activeToasts = new Map();
  const dismissedToasts = new Map();
  const pendingTimers = new Set();
  let nodeSequence = 0;
  let floatingBar;
  let observer;
  let refreshTimer;
  let watchdogTimer;
  let anchorTimer;
  let waitingTimer;
  let rescanEndTimer;
  let manualRescanActive = false;
  let extensionStale = false;
  let saveDirectoryHandle = null;
  let saveDirectoryName = "";

  bootstrap();

  async function bootstrap() {
    try {
      await waitForBody();
      init();
    } catch (error) {
      console.error("[Snapshot Keeper] bootstrap failed", error);
    }
  }

  function init() {
    floatingBar = createFloatingBar();
    mountFloatingBar();
    bindFloatingBarActions(floatingBar);
    bindFloatingBarAnchor();
    updateFloatingBarAnchor();
    initializeContext();
    observeStorageChanges();
    observeMessages();
    startObserver();
    startWatchdog();
    restoreSnapshotDirectoryHandle().catch((error) => debugLog("[SK fs] restore failed", { error: String(error?.message || error) }));
    scheduleInspection("boot");
  }

  function startObserver() {
    if (!document.body || extensionStale) {
      return;
    }
    observer = new MutationObserver((mutations) => {
      if (!mutations.some(shouldInspectMutation)) {
        return;
      }
      debugLog("[SK live] observer fired", { url: location.href });
      scheduleInspection("live");
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function shouldInspectMutation(mutation) {
    if (!mutation) {
      return false;
    }
    if (isIgnoredMutationNode(mutation.target)) {
      return false;
    }
    const addedNodes = [...mutation.addedNodes || []];
    if (addedNodes.length > 0) {
      return addedNodes.some((node) => isAssistantMutationNode(node));
    }
    return isAssistantMutationNode(mutation.target);
  }

  function isExtensionUiNode(node) {
    if (!node) {
      return false;
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement || node.parentNode;
    return Boolean(element?.closest?.("#snapshot-keeper-bar, .snapshot-keeper-notice"));
  }

  function isIgnoredMutationNode(node) {
    if (!node) {
      return true;
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement || node.parentNode;
    if (!element) {
      return true;
    }
    if (isExtensionUiNode(element)) {
      return true;
    }
    return Boolean(element.closest?.(
      "textarea, input, form, [contenteditable='true'], [data-message-author-role='user']"
    ));
  }

  function isAssistantMutationNode(node) {
    if (!node) {
      return false;
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement || node.parentNode;
    if (!element || isIgnoredMutationNode(element)) {
      return false;
    }
    return Boolean(element.matches?.("[data-message-author-role='assistant']") || element.querySelector?.("[data-message-author-role='assistant']") || element.closest?.("[data-message-author-role='assistant']"));
  }

  function startWatchdog() {
    window.clearInterval(watchdogTimer);
    watchdogTimer = window.setInterval(() => {
      if (extensionStale) {
        window.clearInterval(watchdogTimer);
        return;
      }
      mountFloatingBar();
      scheduleFloatingBarAnchorUpdate();
      if (!observer) {
        startObserver();
      }
    }, BAR_WATCHDOG_MS);
  }

  async function waitForBody() {
    if (document.body) {
      return;
    }
    await new Promise((resolve) => {
      const timer = window.setInterval(() => {
        if (document.body) {
          window.clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  function mountFloatingBar() {
    if (!floatingBar?.root || !document.body) {
      return;
    }
    if (!document.body.contains(floatingBar.root)) {
      document.body.appendChild(floatingBar.root);
    }
  }

  async function initializeContext() {
    try {
      await sendMessage("GET_CONTEXT", { url: location.href });
    } catch (error) {
      renderStatus({ recentText: String(error?.message || error), mode: "error" });
    }
    if (extensionStale) {
      return;
    }
    refreshStatus();
  }

  function scheduleInspection(source = "live") {
    if (extensionStale) {
      return;
    }
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      inspectLatestAssistantMessage(source).catch(handleAsyncError);
    }, 250);
  }

  async function inspectLatestAssistantMessage(source = "live") {
    if (extensionStale) {
      return;
    }
    const nodes = getAssistantMessageCandidates();
    if (source === "boot" || source === "manual_rescan") {
      debugLog("[SK scan] visible assistant count", { count: nodes.filter(isVisible).length, source });
    }
    const latest = nodes[nodes.length - 1];
    if (!latest) {
      clearWaitingDisplay({ recentText: "assistant message not found" });
      return;
    }
    debugLog("[SK live] candidate node found", { source, totalCandidates: nodes.length });
    await inspectNodeWhenStable(latest, source === "boot" ? "boot_scan" : "latest");
  }

  async function rescanVisibleMessages() {
    if (extensionStale) {
      renderStatus({ recentText: "extension reloaded · refresh tab", mode: "error" });
      return;
    }
    window.clearTimeout(rescanEndTimer);
    manualRescanActive = true;
    renderStatus({ compactState: "rescanning", recentText: "rescanning visible snapshots", mode: "pending" });
    try {
      const visibleNodes = getAssistantMessageCandidates().filter(isVisible);
      debugLog("[SK scan] visible assistant count", { count: visibleNodes.length, source: "manual_rescan" });
      for (const node of visibleNodes) {
        await inspectNodeWhenStable(node, "manual_rescan");
      }
    } finally {
      rescanEndTimer = window.setTimeout(() => {
        manualRescanActive = false;
        refreshStatus();
      }, 500);
    }
  }

  async function inspectNodeWhenStable(node, source) {
    if (extensionStale) {
      return;
    }
    const payload = extractCandidatePayload(node);
    if (!payload.rawVisibleText.trim()) {
      clearWaitingDisplay();
      return;
    }

    const state = nodeState.get(node) || {};
    if (state.lastText !== payload.rawVisibleText) {
      window.clearTimeout(state.timer);
      if (state.timer) {
        pendingTimers.delete(state.timer);
      }
      state.lastText = payload.rawVisibleText;
      state.retryCount = 0;
      if (source === "latest") {
        setWaitingDisplay("waiting for response");
      }
      debugLog("[SK live] text stable start", {
        source,
        rawVisibleTextLength: payload.rawVisibleText.length
      });
      state.timer = window.setTimeout(() => {
        pendingTimers.delete(state.timer);
        debugLog("[SK live] text stable complete", { source });
        inspectStableNode(node, source).catch(handleAsyncError);
      }, STABILITY_MS);
      pendingTimers.add(state.timer);
      nodeState.set(node, state);
      ensureNodeBinding(node);
      return;
    }

    if (!state.timer) {
      state.timer = window.setTimeout(() => {
        pendingTimers.delete(state.timer);
        debugLog("[SK live] text stable complete", { source });
        inspectStableNode(node, source).catch(handleAsyncError);
      }, STABILITY_MS);
      pendingTimers.add(state.timer);
      nodeState.set(node, state);
    }
  }

  async function inspectStableNode(node, source) {
    if (extensionStale) {
      return;
    }
    const mode = source === "manual_rescan" || source === "boot_scan" ? "scan" : "live";
    const payload = extractCandidatePayload(node);
    const text = payload.rawVisibleText;
    const state = nodeState.get(node) || {};
    state.timer = null;

    const fingerprint = simpleFingerprint(text);
    if (state.processedFingerprint === fingerprint && source !== "manual_rescan") {
      nodeState.set(node, state);
      clearWaitingDisplay();
      return;
    }

    const binding = await ensureNodeBinding(node);
    const parsed = parseAssistantPayload(payload);
    debugLog("[SK diff]", {
      mode,
      turn: parsed.turn,
      markerScanTextLength: payload.markerScanText.length,
      bodyTextLength: parsed.snapshotText.length,
      parseDecision: parsed.parseDecision,
      reason: parsed.markerStatus.reason || null
    });
    debugLog("[SK parser]", {
      turn: parsed.turn,
      isSnapshotTurn: Boolean(parsed.turn && parsed.turn % 10 === 0),
      sourceNodeValid: binding.isAssistantSingleNode === true,
      markerScanTextLength: payload.markerScanText.length,
      rawVisibleTextLength: payload.rawVisibleText.length,
      matchingStartCount: parsed.markerStatus.startCount,
      endCountAfterStart: parsed.markerStatus.endCountAfterStart,
      detectedSections: parsed.detectedSections,
      parseDecision: parsed.parseDecision
    });
    debugLog(mode === "scan" ? "[SK scan] candidate turn" : "[SK live] parsedTurn", {
      turn: parsed.turn,
      parseDecision: parsed.parseDecision
    });
    debugLog("[SK live] isSnapshotTurn", { isSnapshotTurn: Boolean(parsed.turn && parsed.turn % 10 === 0) });
    debugLog("[SK live] hasMatchingStart", { hasMatchingStart: parsed.markerStatus.hasStart });
    debugLog("[SK live] hasEndAfterStart", { hasEndAfterStart: parsed.markerStatus.hasEnd });
    debugLog("[SK live] detectedSections", { detectedSections: parsed.detectedSections });
    debugLog("[SK live] parseDecision", { parseDecision: parsed.parseDecision });

    if (!parsed.turn) {
      state.processedFingerprint = fingerprint;
      nodeState.set(node, state);
      clearWaitingDisplay();
      return;
    }

    await sendMessage("TURN_SEEN", {
      turn: parsed.turn,
      nodeBinding: binding,
      source
    });
    if (extensionStale) {
      return;
    }
    renderStatus({
      ...(mode === "live" ? { currentTurn: parsed.turn } : { compactState: "rescanning" }),
      recentText: `turn ${parsed.turn} observed`
    });

    if (parsed.turn % 10 !== 0) {
      state.processedFingerprint = fingerprint;
      nodeState.set(node, state);
      refreshStatus();
      return;
    }

    if (binding.isAssistantSingleNode !== true) {
      renderStatus({ recentText: `turn ${parsed.turn} seen, snapshot blocked by source check` });
      state.processedFingerprint = fingerprint;
      nodeState.set(node, state);
      refreshStatus();
      return;
    }

    if (!isGenerationIdle()) {
      renderStatus({ recentText: "waiting for generation to finish" });
      debugLog("[SK live] generation complete detected", { complete: false, source });
      scheduleParseRetry(node, source, "generation_not_complete");
      return;
    }
    debugLog("[SK live] generation complete detected", { complete: true, source });

    if (!KOREA_TIME_RE.test(text.trim())) {
      renderStatus({ recentText: "waiting for final Korea time line" });
      scheduleParseRetry(node, source, "korea_time_missing");
      return;
    }

    if (parsed.markerStatus.invalid) {
      const eventKey = buildEventKey(binding, parsed, "invalid", parsed.markerStatus.reason);
      const alreadyProcessed = !markEventForProcessing(eventKey);
      debugLog("[SK event]", { eventKey, alreadyProcessed });
      if (alreadyProcessed) {
        state.processedFingerprint = fingerprint;
        nodeState.set(node, state);
        refreshStatus();
        return;
      }
      await sendMessage("INVALID_SNAPSHOT", {
        turn: parsed.turn,
        markerStatus: parsed.markerStatus,
        reason: parsed.markerStatus.reason,
        eventKey,
        toastKey: eventKey,
        nodeBinding: binding,
        detectedAt: new Date().toISOString(),
        source
      });
      if (extensionStale) {
        return;
      }
      debugLog(sentEventLabel(mode, "invalid_snapshot"), {
        sent: "invalid",
        turn: parsed.turn,
        reason: parsed.markerStatus.reason
      });
      state.processedFingerprint = fingerprint;
      nodeState.set(node, state);
      refreshStatus();
      return;
    }

    if (parsed.markerStatus.incomplete) {
      renderStatus({ recentText: `turn ${parsed.turn} snapshot incomplete` });
      debugLog("[SK parser]", { parseDecision: parsed.parseDecision });
      scheduleParseRetry(node, source, "incomplete_snapshot");
      refreshStatus();
      return;
    }

    if (!parsed.markerStatus.hasStart || !parsed.markerStatus.hasEnd) {
      await sendMissingCandidate(parsed, binding, "snapshot_markers_missing", source);
      if (extensionStale) {
        return;
      }
      debugLog(sentEventLabel(mode, "missing_candidate"), {
        sent: "missing",
        turn: parsed.turn,
        reason: "snapshot_markers_missing"
      });
      state.processedFingerprint = fingerprint;
      nodeState.set(node, state);
      refreshStatus();
      return;
    }

    if (parsed.missingSections.length > 0) {
      await sendMissingCandidate(parsed, binding, "required_sections_missing", source);
      if (extensionStale) {
        return;
      }
      debugLog(sentEventLabel(mode, "missing_candidate"), {
        sent: "missing",
        turn: parsed.turn,
        reason: "required_sections_missing"
      });
      state.processedFingerprint = fingerprint;
      nodeState.set(node, state);
      refreshStatus();
      return;
    }

    debugLog(sentEventLabel(mode, "snapshot_candidate"), {
      sent: "snapshot_candidate",
      turn: parsed.turn,
      stage: "before_send"
    });
    renderStatus({ recentText: `turn ${parsed.turn} snapshot candidate sent`, mode: "pending" });
    const snapshotResponse = await sendMessage("SNAPSHOT_CANDIDATE", {
      turn: parsed.turn,
      snapshotText: parsed.snapshotText,
      nodeBinding: binding,
      detectedAt: new Date().toISOString(),
      source
    });
    if (extensionStale) {
      return;
    }
    debugLog(mode === "scan" ? "[SK scan] snapshot_candidate response" : "[SK live] snapshot_candidate response", {
      turn: parsed.turn,
      snapshotResult: snapshotResponse.snapshotResult || null
    });
    state.processedFingerprint = fingerprint;
    nodeState.set(node, state);
    await refreshStatus();
    renderStatus({ recentText: formatSnapshotResult(parsed.turn, snapshotResponse.snapshotResult), mode: modeForSnapshotResult(snapshotResponse.snapshotResult) });
  }

  function scheduleParseRetry(node, source, reason) {
    if (extensionStale) {
      return;
    }
    const state = nodeState.get(node) || {};
    const retryCount = Number(state.retryCount || 0);
    if (retryCount >= PARSE_RETRY_LIMIT) {
      debugLog("[SK live] parse retry stopped", { source, reason, retryCount });
      nodeState.set(node, state);
      return;
    }
    if (state.timer) {
      window.clearTimeout(state.timer);
      pendingTimers.delete(state.timer);
    }
    state.retryCount = retryCount + 1;
    state.pendingParse = true;
    state.pendingReason = reason;
    state.timer = window.setTimeout(() => {
      pendingTimers.delete(state.timer);
      inspectStableNode(node, source).catch(handleAsyncError);
    }, PARSE_RETRY_DELAY_MS);
    pendingTimers.add(state.timer);
    nodeState.set(node, state);
    debugLog("[SK live] pending parse retry", {
      source,
      reason,
      retryCount: state.retryCount
    });
  }

  function sentEventLabel(mode, eventName) {
    return SENT_EVENT_LABELS[mode === "scan" ? "scan" : "live"][eventName];
  }

  function formatSnapshotResult(turn, result) {
    if (!result) {
      return `turn ${turn} snapshot response missing`;
    }
    if (result.saveStateAfter === "save_pending") {
      return `turn ${turn} bg save_pending`;
    }
    if (result.saveStateAfter === "save_confirmed") {
      return `turn ${turn} bg save_confirmed`;
    }
    if (result.saveStateAfter === "save_error") {
      return `turn ${turn} bg save_error: ${result.reason || "unknown"}`;
    }
    if (result.saveStateAfter === "duplicate_ignored") {
      return `turn ${turn} duplicate ignored`;
    }
    return `turn ${turn} bg ${result.saveStateAfter || "processed"}`;
  }

  function modeForSnapshotResult(result) {
    if (!result) {
      return "error";
    }
    if (result.saveStateAfter === "save_pending") {
      return "pending";
    }
    if (result.saveStateAfter === "save_confirmed") {
      return "confirmed";
    }
    if (result.saveStateAfter === "save_error") {
      return "error";
    }
    return undefined;
  }

  async function sendMissingCandidate(parsed, binding, reason, source) {
    await sendMessage("MISSING_CANDIDATE", {
      turn: parsed.turn,
      markerStatus: parsed.markerStatus,
      missingSections: parsed.missingSections,
      reason,
      nodeBinding: binding,
      detectedAt: new Date().toISOString(),
      source
    });
  }

  function parseAssistantPayload(payload) {
    const rawVisibleText = payload.rawVisibleText || "";
    const markdownText = payload.markdownText || rawVisibleText;
    const markerScanText = payload.markerScanText || rawVisibleText;
    const turnMatch = markerScanText.match(TURN_MARKDOWN_RE) || markerScanText.match(TURN_RENDERED_RE) ||
      rawVisibleText.match(TURN_MARKDOWN_RE) || rawVisibleText.match(TURN_RENDERED_RE);
    const turn = turnMatch ? Number(turnMatch[1]) : null;
    const lines = splitLinesWithOffsets(markerScanText);
    const starts = turn ? findMatchingStartLines(lines, turn) : [];
    const ends = findEndLines(lines);
    const firstStart = starts[0] || null;
    const endsBeforeStart = firstStart ? ends.filter((line) => line.offset < firstStart.offset) : [];
    const endsAfterStart = firstStart ? ends.filter((line) => line.offset > firstStart.offset) : [];
    const firstEndAfterStart = endsAfterStart[0] || null;
    const blockText = firstStart && firstEndAfterStart
      ? markerScanText.slice(firstStart.endOffset, firstEndAfterStart.offset).trim()
      : "";
    const detectedSections = detectSections(blockText);
    const markerStatus = {
      hasStart: starts.length > 0,
      hasEnd: Boolean(firstEndAfterStart),
      startCount: starts.length,
      endCount: ends.length,
      endCountAfterStart: endsAfterStart.length,
      markerTurn: firstStart ? firstStart.turn : null,
      invalid: false,
      incomplete: false,
      reason: null,
      markerHash: simpleFingerprint(`${firstStart?.text || ""}\n${firstEndAfterStart?.text || ""}\n${blockText}`)
    };

    let snapshotText = "";
    let parseDecision = "no_turn";

    if (turn && starts.length === 0) {
      parseDecision = "missing_start";
    }

    if (starts.length > 1) {
      markerStatus.invalid = true;
      markerStatus.reason = "ambiguous_snapshot_marker";
      parseDecision = "invalid_ambiguous_start";
    }

    if (!markerStatus.invalid && firstStart && endsBeforeStart.length > 0) {
      markerStatus.invalid = true;
      markerStatus.reason = "malformed_snapshot_marker";
      parseDecision = "invalid_malformed_marker_order";
    }

    if (!markerStatus.invalid && firstStart && endsAfterStart.length === 0) {
      markerStatus.incomplete = true;
      markerStatus.reason = "incomplete_snapshot";
      parseDecision = "incomplete_snapshot";
    }

    if (!markerStatus.invalid && firstStart && endsAfterStart.length > 1) {
      markerStatus.invalid = true;
      markerStatus.reason = "ambiguous_snapshot_marker";
      parseDecision = "invalid_ambiguous_end";
    }

    if (!markerStatus.invalid && !markerStatus.incomplete && firstStart && firstEndAfterStart) {
      snapshotText = extractSnapshotBodyText(markdownText, turn, detectedSections) ||
        extractSnapshotBodyText(rawVisibleText, turn, detectedSections) ||
        blockText;
      parseDecision = "snapshot_candidate";
    }

    const missingSections = markerStatus.hasStart && markerStatus.hasEnd && !markerStatus.invalid && !markerStatus.incomplete
      ? SNAPSHOT_SECTIONS.filter((section) => !detectedSections.includes(normalizeSectionName(section)))
      : [...SNAPSHOT_SECTIONS];

    if (parseDecision === "snapshot_candidate" && missingSections.length > 0) {
      parseDecision = "missing_sections";
    }

    return {
      turn,
      markerStatus,
      missingSections,
      detectedSections,
      snapshotText,
      normalizedTextHash: simpleFingerprint(normalizeForEventKey(markerScanText || rawVisibleText)),
      parseDecision
    };
  }

  function splitLinesWithOffsets(text) {
    const lines = [];
    let offset = 0;
    for (const line of String(text || "").split(/\n/)) {
      lines.push({
        text: line,
        trimmed: line.trim(),
        offset,
        endOffset: offset + line.length + 1
      });
      offset += line.length + 1;
    }
    return lines;
  }

  function findMatchingStartLines(lines, turn) {
    return lines.flatMap((line) => {
      const match = line.trimmed.match(/^SNAPSHOT_START\s+turn\s*=\s*(\d+)\s*$/i);
      if (!match || Number(match[1]) !== Number(turn)) {
        return [];
      }
      return [{
        ...line,
        turn: Number(match[1])
      }];
    }).filter((line, index, all) => {
      const nextEnd = findEndLines(lines).find((endLine) => endLine.offset > line.offset);
      if (!nextEnd) {
        return true;
      }
      const blockText = linesTextBetweenOffsets(lines, line.endOffset, nextEnd.offset);
      const detected = detectSections(blockText);
      if (detected.length > 0) {
        return true;
      }
      return all.length === 1 && index === 0;
    });
  }

  function findEndLines(lines) {
    return lines.filter((line) => /^SNAPSHOT_END\s*$/i.test(line.trimmed));
  }

  function linesTextBetweenOffsets(lines, startOffset, endOffset) {
    return lines
      .filter((line) => line.offset >= startOffset && line.offset < endOffset)
      .map((line) => line.text)
      .join("\n")
      .trim();
  }

  function detectSections(text) {
    const normalizedLines = String(text || "").split(/\n/).map((line) => normalizeSectionName(line));
    return SNAPSHOT_SECTIONS
      .map((section) => normalizeSectionName(section))
      .filter((section) => normalizedLines.some((line) => line === section || line.startsWith(`${section} `)));
  }

  function normalizeSectionName(value) {
    return String(value || "")
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/\s+/g, " ");
  }

  function extractSnapshotBodyText(rawVisibleText, turn, detectedSections) {
    const lines = splitLinesWithOffsets(rawVisibleText);
    const starts = lines.filter((line) => {
      const match = line.trimmed.match(/^SNAPSHOT_START\s+turn\s*=\s*(\d+)\s*$/i);
      return match && Number(match[1]) === Number(turn);
    });
    const ends = findEndLines(lines);
    const candidates = starts.flatMap((start) => {
      const end = ends.find((endLine) => endLine.offset > start.offset);
      if (!end) {
        return [];
      }
      const body = rawVisibleText.slice(start.endOffset, end.offset).trim();
      const bodySections = detectSections(body);
      return [{
        body,
        sectionScore: bodySections.filter((section) => detectedSections.includes(section)).length,
        totalSections: bodySections.length
      }];
    });
    if (candidates.length === 0) {
      return "";
    }
    candidates.sort((a, b) => b.sectionScore - a.sectionScore || b.totalSections - a.totalSections);
    return candidates[0].body;
  }

  async function ensureNodeBinding(node) {
    const existing = nodeBindings.get(node);
    if (existing && !shouldRefreshBinding(existing)) {
      return existing;
    }

    const assistantNode = getAssistantRoot(node);
    const binding = existing || {
      sourceNodeId: `assistant-${++nodeSequence}`,
      createdAt: new Date().toISOString()
    };
    Object.assign(binding, {
      url: location.href,
      isAssistantCandidate: isAssistantMessageCandidate(assistantNode),
      isAssistantSingleNode: isSingleAssistantMessageNode(assistantNode)
    });

    try {
      const response = await sendMessage("GET_CONTEXT", { url: location.href });
      Object.assign(binding, {
        conversationKey: response.context?.currentConversationKey,
        navigationEpoch: response.context?.navigationEpoch
      });
      debugLog("[SK binding]", {
        nodeBindingConversationKey: binding.conversationKey,
        currentConversationKey: response.context?.currentConversationKey,
        stale: false,
        decision: binding.isAssistantSingleNode ? "bind_single_assistant" : "bind_assistant_candidate"
      });
    } catch (error) {
      binding.error = String(error?.message || error);
      debugLog("[SK binding]", {
        nodeBindingConversationKey: null,
        currentConversationKey: null,
        stale: null,
        decision: "binding_error",
        error: binding.error
      });
    }

    nodeBindings.set(node, binding);
    return binding;
  }

  function shouldRefreshBinding(binding) {
    if (!binding) {
      return true;
    }
    if (binding.url !== location.href) {
      return true;
    }
    return Boolean(hasConversationId(location.href) && String(binding.conversationKey || "").startsWith("chatgpt:tab-"));
  }

  function hasConversationId(url) {
    try {
      return /^\/c\/[^/?#]+/.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  function getAssistantMessageCandidates() {
    const nodes = [
      ...document.querySelectorAll('[data-message-author-role="assistant"]')
    ].map(getAssistantRoot).filter(Boolean);
    return [...new Set(nodes)].filter(isAssistantMessageCandidate);
  }

  function getAssistantRoot(node) {
    return node?.closest?.('[data-message-author-role="assistant"]') || null;
  }

  function isSingleAssistantMessageNode(node) {
    if (!isAssistantMessageCandidate(node)) {
      return false;
    }
    if (node.querySelector('textarea, input, [contenteditable="true"], form')) {
      return false;
    }
    return true;
  }

  function isAssistantMessageCandidate(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    if (node.getAttribute("data-message-author-role") !== "assistant") {
      return false;
    }
    if (node.querySelector('[data-message-author-role="user"]')) {
      return false;
    }
    return true;
  }

  function extractCandidatePayload(node) {
    const assistantNode = getAssistantRoot(node);
    if (!isAssistantMessageCandidate(assistantNode)) {
      return {
        rawVisibleText: "",
        markerScanText: ""
      };
    }
    return {
      rawVisibleText: assistantNode.innerText || assistantNode.textContent || "",
      markdownText: buildMarkdownText(assistantNode),
      markerScanText: buildMarkerScanText(assistantNode)
    };
  }

  function buildMarkerScanText(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll("pre, code").forEach((node) => node.remove());
    return (clone.innerText || clone.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function buildMarkdownText(root) {
    return normalizeBlockMarkdown(childrenToBlockMarkdown(root, { listDepth: 0 }));
  }

  function nodeToMarkdown(node, context = {}) {
    if (!node) {
      return "";
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return normalizeInlineText(node.textContent || "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tag = element.tagName.toLowerCase();
    if (shouldSkipMarkdownNode(element, tag)) {
      return "";
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `${"#".repeat(level)} ${childrenToInlineMarkdown(element, context).trim()}`;
    }
    if (tag === "br") {
      return "\n";
    }
    if (tag === "code" && element.closest("pre")) {
      return element.textContent || "";
    }
    if (tag === "code") {
      return wrapInlineCode(element.textContent || "");
    }
    if (tag === "pre") {
      const code = element.textContent || "";
      return `\`\`\`\n${code.replace(/\n+$/g, "")}\n\`\`\``;
    }
    if (tag === "ul" || tag === "ol") {
      return listToMarkdown(element, tag === "ol", context);
    }
    if (tag === "li") {
      return childrenToBlockMarkdown(element, context).trim();
    }
    if (tag === "blockquote") {
      return childrenToBlockMarkdown(element, context)
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    }
    if (tag === "strong" || tag === "b") {
      const text = childrenToInlineMarkdown(element, context).trim();
      return text ? `**${text}**` : "";
    }
    if (tag === "em" || tag === "i") {
      const text = childrenToInlineMarkdown(element, context).trim();
      return text ? `*${text}*` : "";
    }

    const blockTags = new Set(["p", "div", "section", "article", "main", "header", "footer"]);
    return blockTags.has(tag)
      ? childrenToBlockMarkdown(element, context)
      : childrenToInlineMarkdown(element, context);
  }

  function shouldSkipMarkdownNode(element, tag) {
    if (["script", "style", "svg", "button", "form", "textarea", "input", "select", "nav"].includes(tag)) {
      return true;
    }
    if (element.closest("[contenteditable='true']")) {
      return true;
    }
    if (element.getAttribute("aria-hidden") === "true") {
      return true;
    }
    return false;
  }

  function childrenToInlineMarkdown(element, context) {
    return [...element.childNodes]
      .map((child) => nodeToMarkdown(child, context))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ");
  }

  function childrenToBlockMarkdown(element, context) {
    const parts = [];
    let inlineRun = "";

    const flushInlineRun = () => {
      const inline = normalizeBlockMarkdown(inlineRun);
      if (inline) {
        parts.push(inline);
      }
      inlineRun = "";
    };

    for (const child of element.childNodes) {
      if (isMarkdownBlockChild(child)) {
        flushInlineRun();
        const markdown = normalizeBlockMarkdown(nodeToMarkdown(child, context));
        if (markdown) {
          parts.push(markdown);
        }
      } else {
        inlineRun += nodeToMarkdown(child, context);
      }
    }

    flushInlineRun();
    return parts.join("\n\n");
  }

  function isMarkdownBlockChild(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    const tag = node.tagName?.toLowerCase();
    if (!tag || ["a", "b", "br", "code", "em", "i", "mark", "small", "span", "strong", "sub", "sup"].includes(tag)) {
      return false;
    }
    return /^(article|aside|blockquote|details|div|dl|figure|footer|h[1-6]|header|hr|li|main|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)$/.test(tag);
  }

  function normalizeBlockMarkdown(text) {
    return String(text || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function listToMarkdown(element, ordered, context) {
    const depth = Number(context.listDepth || 0);
    const indent = "  ".repeat(depth);
    let index = 1;
    return [...element.children]
      .filter((child) => child.tagName?.toLowerCase() === "li")
      .map((item) => {
        const marker = ordered ? `${index++}. ` : "- ";
        const nested = nodeToMarkdown(item, { ...context, listDepth: depth + 1 }).trim();
        const lines = nested.split("\n");
        const first = `${indent}${marker}${lines.shift() || ""}`;
        const rest = lines.map((line) => `${indent}  ${line}`);
        return [first, ...rest].join("\n");
      })
      .join("\n");
  }

  function normalizeInlineText(text) {
    return String(text || "").replace(/\s+/g, " ");
  }

  function wrapInlineCode(text) {
    const value = String(text || "");
    const fence = value.includes("`") ? "``" : "`";
    return `${fence}${value}${fence}`;
  }

  function isGenerationIdle() {
    const buttons = [...document.querySelectorAll("button")];
    const stopButton = buttons.find((button) => {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.textContent
      ].filter(Boolean).join(" ").toLowerCase();
      return /stop|중지|정지|응답 중지|stop generating|stop streaming/.test(label);
    });
    return !stopButton;
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0;
  }

  function simpleFingerprint(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return `${text.length}:${hash}`;
  }

  function createFloatingBar() {
    const root = document.createElement("section");
    root.id = "snapshot-keeper-bar";
    root.dataset.expanded = "false";
    root.dataset.debug = DEBUG ? "true" : "false";
    root.dataset.compactState = "empty";
    root.innerHTML = `
      <div class="sk-compact" data-sk-compact title="Snapshot Keeper">
        <span class="sk-compact-ready">SK · turn <b data-sk-turn>-</b> → <b data-sk-next>10</b> · saved <b data-sk-saved>0</b></span>
        <span class="sk-compact-waiting">SK · waiting<span class="sk-dots" aria-hidden="true"></span></span>
        <span class="sk-compact-empty">SK · ready</span>
        <span class="sk-compact-rescanning">SK · saved <b data-sk-rescan-saved>0</b> · rescanning</span>
      </div>
      <div class="sk-panel">
        <div class="sk-header">
          <strong>Snapshot Keeper</strong>
          <span data-sk-status>idle</span>
        </div>
        <div class="sk-grid">
          <span class="sk-debug-only">conversation</span><b class="sk-debug-only" data-sk-conversation>-</b>
          <span>turn</span><b data-sk-turn-detail>-</b>
          <span>next</span><b data-sk-next-detail>turn 10</b>
          <span>saved</span><b data-sk-saved-detail>0</b>
          <span>missing</span><b data-sk-missing>0</b>
          <span>variant</span><b data-sk-variant>0</b>
          <span>folder</span><b data-sk-folder-detail>folder needed</b>
        </div>
        <div class="sk-recent" data-sk-recent>-</div>
        <div class="sk-actions">
          <button type="button" data-sk-set-folder>Set folder</button>
          <button type="button" data-sk-rescan>Rescan</button>
          <button type="button" data-sk-retry>Retry</button>
          <button type="button" data-sk-clear>Clear errors</button>
          <button type="button" data-sk-qa-download>QA save</button>
        </div>
      </div>
    `;
    return {
      root,
      compact: root.querySelector("[data-sk-compact]"),
      status: root.querySelector("[data-sk-status]"),
      conversation: root.querySelector("[data-sk-conversation]"),
      turn: root.querySelector("[data-sk-turn]"),
      turnDetail: root.querySelector("[data-sk-turn-detail]"),
      next: root.querySelector("[data-sk-next]"),
      nextDetail: root.querySelector("[data-sk-next-detail]"),
      saved: root.querySelector("[data-sk-saved]"),
      rescanSaved: root.querySelector("[data-sk-rescan-saved]"),
      savedDetail: root.querySelector("[data-sk-saved-detail]"),
      missing: root.querySelector("[data-sk-missing]"),
      variant: root.querySelector("[data-sk-variant]"),
      folderDetail: root.querySelector("[data-sk-folder-detail]"),
      recent: root.querySelector("[data-sk-recent]"),
      setFolder: root.querySelector("[data-sk-set-folder]"),
      rescan: root.querySelector("[data-sk-rescan]"),
      retry: root.querySelector("[data-sk-retry]"),
      clear: root.querySelector("[data-sk-clear]"),
      qaDownload: root.querySelector("[data-sk-qa-download]")
    };
  }

  function bindFloatingBarActions(bar) {
    bar.compact.addEventListener("click", () => {
      bar.root.dataset.expanded = bar.root.dataset.expanded === "true" ? "false" : "true";
    });
    bar.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        bar.root.dataset.expanded = "false";
      }
    });
    bar.setFolder.addEventListener("click", async () => {
      renderStatus({ recentText: "selecting folder...", mode: "pending" });
      const result = await pickSnapshotDirectoryHandle();
      renderStatus({
        recentText: result?.ok ? `folder ready: ${result.name || "selected"}` : `folder error: ${result?.error || "not selected"}`,
        mode: result?.ok ? "confirmed" : "error"
      });
    });
    bar.rescan.addEventListener("click", () => {
      renderStatus({ recentText: "rescanning visible assistant messages" });
      rescanVisibleMessages().catch((error) => renderStatus({ recentText: String(error?.message || error) }));
    });
    bar.retry.addEventListener("click", async () => {
      const response = await sendMessage("GET_STATUS", {});
      const latest = response.status?.latest;
      if (!latest || latest.saveState !== "save_error") {
        renderStatus({ recentText: "no failed save to retry" });
        return;
      }
      await sendMessage("RETRY_SAVE", {
        conversationKey: response.status.conversationKey,
        turn: latest.turn
      });
      refreshStatus();
    });
    bar.clear.addEventListener("click", async () => {
      const response = await sendMessage("CLEAR_ERRORS", {});
      await refreshStatus();
      renderStatus({
        recentText: response.clearedDownloadPathBroken ? "download block cleared" : "errors cleared",
        mode: "pending"
      });
    });
    bar.qaDownload.addEventListener("click", async () => {
      renderStatus({ recentText: "QA save starting...", mode: "pending" });
      try {
        const response = await sendMessage("QA_DOWNLOAD_TEST", { url: location.href });
        const result = response.qaDownloadResult;
        renderStatus({
          recentText: result?.writeId ? `QA file saved ${result.writeId}` : `QA file ${result?.saveStateAfter || "done"}`,
          mode: result?.saveStateAfter === "save_error" ? "error" : "confirmed"
        });
      } catch (error) {
        renderStatus({ recentText: `QA save failed: ${String(error?.message || error)}`, mode: "error" });
      }
    });
  }

  function bindFloatingBarAnchor() {
    window.addEventListener("resize", scheduleFloatingBarAnchorUpdate, { passive: true });
    window.addEventListener("scroll", scheduleFloatingBarAnchorUpdate, { passive: true, capture: true });
    window.setTimeout(updateFloatingBarAnchor, 300);
    window.setTimeout(updateFloatingBarAnchor, 1200);
  }

  function scheduleFloatingBarAnchorUpdate() {
    if (extensionStale) {
      return;
    }
    window.clearTimeout(anchorTimer);
    anchorTimer = window.setTimeout(updateFloatingBarAnchor, 120);
  }

  function updateFloatingBarAnchor() {
    if (!floatingBar?.root || extensionStale) {
      return;
    }
    const rect = findComposerAnchorRect();
    if (!rect) {
      floatingBar.root.style.removeProperty("--sk-anchor-x");
      floatingBar.root.dataset.anchor = "viewport";
      return;
    }
    const center = Math.round(rect.left + rect.width / 2);
    const min = 120;
    const max = Math.max(min, window.innerWidth - 120);
    const clamped = Math.min(Math.max(center, min), max);
    floatingBar.root.style.setProperty("--sk-anchor-x", `${clamped}px`);
    floatingBar.root.dataset.anchor = "composer";
  }

  function findComposerAnchorRect() {
    const candidates = [
      ...document.querySelectorAll("form textarea, form [contenteditable='true'], textarea, [contenteditable='true'][role='textbox']")
    ];
    for (const input of candidates) {
      if (!isUsableComposerInput(input)) {
        continue;
      }
      const container = input.closest("form") || input.closest("[data-type='unified-composer']") || input.parentElement;
      const rect = getUsableRect(container) || getUsableRect(input);
      if (rect) {
        return rect;
      }
    }
    const promptTextarea = document.querySelector("#prompt-textarea, [data-testid='composer-text-input']");
    const promptRect = promptTextarea ? getUsableRect(promptTextarea.closest("form") || promptTextarea) : null;
    return promptRect;
  }

  function isUsableComposerInput(element) {
    if (!element || !document.body.contains(element)) {
      return false;
    }
    if (element.closest("#snapshot-keeper-bar, .snapshot-keeper-notice")) {
      return false;
    }
    const rect = getUsableRect(element);
    if (!rect) {
      return false;
    }
    return rect.bottom > window.innerHeight * 0.45;
  }

  function getUsableRect(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") {
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 160 || rect.height < 20) {
      return null;
    }
    return rect;
  }

  function setWaitingDisplay(recentText = "waiting for response") {
    renderStatus({ waiting: true, recentText, mode: "pending" });
    window.clearTimeout(waitingTimer);
    waitingTimer = window.setTimeout(() => {
      clearWaitingDisplay();
    }, WAITING_DISPLAY_TTL_MS);
  }

  function clearWaitingDisplay(update = {}) {
    window.clearTimeout(waitingTimer);
    waitingTimer = null;
    if (floatingBar?.root?.dataset.compactState === "waiting") {
      refreshStatus().catch((error) => renderStatus({
        compactState: hasDisplayedTurn() ? "ready" : "empty",
        recentText: update.recentText || String(error?.message || error || "ready")
      }));
      return;
    }
    if (update.recentText) {
      renderStatus(update);
    }
  }

  function hasDisplayedTurn() {
    return Number(floatingBar?.turn?.textContent || 0) > 0;
  }

  function supportsDirectorySave() {
    return Boolean(window.isSecureContext && typeof window.showDirectoryPicker === "function");
  }

  function openSettingsDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("indexed_db_unavailable"));
        return;
      }
      const request = indexedDB.open(SETTINGS_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("indexed_db_open_failed"));
    });
  }

  async function readSettingsValue(key) {
    const db = await openSettingsDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SETTINGS_STORE, "readonly");
      const store = tx.objectStore(SETTINGS_STORE);
      const request = store.get(key);
      tx.oncomplete = () => db.close();
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error("indexed_db_read_failed"));
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("indexed_db_read_failed"));
    });
  }

  async function writeSettingsValue(key, value) {
    const db = await openSettingsDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SETTINGS_STORE, "readwrite");
      const store = tx.objectStore(SETTINGS_STORE);
      store.put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error("indexed_db_write_failed"));
      };
      tx.onerror = () => reject(tx.error || new Error("indexed_db_write_failed"));
    });
  }

  async function deleteSettingsValue(key) {
    const db = await openSettingsDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SETTINGS_STORE, "readwrite");
      const store = tx.objectStore(SETTINGS_STORE);
      store.delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error("indexed_db_delete_failed"));
      };
      tx.onerror = () => reject(tx.error || new Error("indexed_db_delete_failed"));
    });
  }

  async function ensureDirectoryWritePermission(handle, { request = false } = {}) {
    if (!handle) {
      return false;
    }
    const descriptor = { mode: "readwrite" };
    try {
      if (request && handle.requestPermission) {
        return (await handle.requestPermission(descriptor)) === "granted";
      }
      if (handle.queryPermission) {
        return (await handle.queryPermission(descriptor)) === "granted";
      }
      return true;
    } catch (error) {
      debugLog("[SK fs] permission check failed", { error: String(error?.message || error) });
      return false;
    }
  }

  async function persistSnapshotDirectoryHandle(handle) {
    if (!handle) {
      return false;
    }
    try {
      await writeSettingsValue(SAVE_DIRECTORY_HANDLE_KEY, handle);
      return true;
    } catch (error) {
      debugLog("[SK fs] persist failed", { error: String(error?.message || error) });
      return false;
    }
  }

  async function clearSnapshotDirectoryHandle({ persist = true } = {}) {
    saveDirectoryHandle = null;
    saveDirectoryName = "";
    if (!persist) {
      return;
    }
    try {
      await deleteSettingsValue(SAVE_DIRECTORY_HANDLE_KEY);
    } catch (error) {
      debugLog("[SK fs] clear persisted handle failed", { error: String(error?.message || error) });
    }
  }

  async function restoreSnapshotDirectoryHandle() {
    if (saveDirectoryHandle || !supportsDirectorySave()) {
      return saveDirectoryHandle;
    }
    try {
      const handle = await readSettingsValue(SAVE_DIRECTORY_HANDLE_KEY);
      if (handle?.kind === "directory") {
        saveDirectoryHandle = handle;
        saveDirectoryName = handle.name || "";
        const granted = await ensureDirectoryWritePermission(handle, { request: false });
        renderStatus({
          recentText: granted ? `folder restored: ${saveDirectoryName || "selected"}` : "directory_permission_required",
          mode: granted ? undefined : "error"
        });
      }
    } catch (error) {
      debugLog("[SK fs] restore failed", { error: String(error?.message || error) });
    }
    return saveDirectoryHandle;
  }

  async function pickSnapshotDirectoryHandle({ silentCancel = false } = {}) {
    if (!supportsDirectorySave()) {
      return { ok: false, error: "file_system_access_unavailable" };
    }
    try {
      const handle = await window.showDirectoryPicker({
        id: "snapshot-keeper-save-folder",
        mode: "readwrite",
        startIn: "downloads"
      });
      const granted = await ensureDirectoryWritePermission(handle, { request: true });
      if (!granted) {
        return { ok: false, error: "directory_permission_required" };
      }
      saveDirectoryHandle = handle;
      saveDirectoryName = handle.name || "";
      const persisted = await persistSnapshotDirectoryHandle(handle);
      debugLog("[SK fs] folder picked", { name: saveDirectoryName, persisted });
      return { ok: true, name: saveDirectoryName, persisted };
    } catch (error) {
      if (error?.name === "AbortError") {
        return { ok: false, error: silentCancel ? "directory_picker_cancelled_silent" : "directory_picker_cancelled" };
      }
      debugLog("[SK fs] folder pick failed", { error: String(error?.message || error) });
      return { ok: false, error: normalizeFileSystemError(error) };
    }
  }

  async function ensureSnapshotDirectoryHandle({ promptIfMissing = false } = {}) {
    let handle = saveDirectoryHandle || await restoreSnapshotDirectoryHandle();
    if (!handle) {
      if (promptIfMissing) {
        const picked = await pickSnapshotDirectoryHandle();
        return picked.ok ? saveDirectoryHandle : null;
      }
      return null;
    }
    const granted = await ensureDirectoryWritePermission(handle, { request: promptIfMissing });
    if (granted) {
      saveDirectoryHandle = handle;
      saveDirectoryName = handle.name || saveDirectoryName || "";
      return handle;
    }
    if (!promptIfMissing) {
      return null;
    }
    await clearSnapshotDirectoryHandle();
    const picked = await pickSnapshotDirectoryHandle({ silentCancel: true });
    return picked.ok ? saveDirectoryHandle : null;
  }

  async function writeSnapshotFileFromMessage(payload = {}) {
    const filePath = String(payload.filePath || "");
    const markdown = String(payload.markdown || "");
    const handle = await ensureSnapshotDirectoryHandle({ promptIfMissing: false });
    if (!handle) {
      throw new Error("directory_permission_required");
    }
    const safeParts = getSafeRelativePathParts(filePath);
    await writeTextFileRelative(handle, safeParts, markdown);
    const actualPath = [handle.name || "", ...safeParts].filter(Boolean).join("/");
    debugLog("[SK fs] write complete", { filePath, actualPath });
    return {
      filePath,
      actualPath,
      rootName: handle.name || "",
      writer: "file_system_access"
    };
  }

  function getSafeRelativePathParts(filePath) {
    const parts = String(filePath || "")
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === "." || part === ".." || /[\x00-\x1f]/.test(part))) {
      throw new Error("unsafe_relative_file_path");
    }
    return parts;
  }

  async function writeTextFileRelative(rootHandle, pathParts, text) {
    let directory = rootHandle;
    for (const part of pathParts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    const filename = pathParts[pathParts.length - 1];
    const fileHandle = await directory.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(text);
    } finally {
      await writable.close();
    }
  }

  function normalizeFileSystemError(error) {
    if (typeof error === "string") {
      return error;
    }
    if (error?.message === "directory_permission_required") {
      return "directory_permission_required";
    }
    if (error?.message === "unsafe_relative_file_path") {
      return "unsafe_relative_file_path";
    }
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      return "directory_permission_required";
    }
    if (error?.name === "NotFoundError") {
      return "directory_not_found";
    }
    if (error?.name === "AbortError") {
      return "directory_picker_cancelled";
    }
    return "file_system_write_failed";
  }

  function observeStorageChanges() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.snapshotKeeperState) {
        refreshStatus();
      }
    });
  }

  function observeMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message?.type) {
        return;
      }
      if (message.type === "WRITE_SNAPSHOT_FILE") {
        writeSnapshotFileFromMessage(message.payload)
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((error) => sendResponse({
            ok: false,
            error: normalizeFileSystemError(error),
            errorMessage: String(error?.message || error)
          }));
        return true;
      }
      let shouldRefresh = true;
      if (message.type === "SAVE_PENDING") {
        renderStatus({ waiting: false, recentText: `turn ${message.turn} saving...`, mode: "pending" });
      } else if (message.type === "SAVE_CONFIRMED") {
        renderStatus({ waiting: false, recentText: `turn ${message.turn} saved`, mode: "confirmed" });
        showNotice("Saved", `turn ${message.turn} snapshot saved`, "success", true, `saved:${message.conversationKey}:${message.turn}:${message.filePath}`);
      } else if (message.type === "MISSING_PENDING") {
        renderStatus({ waiting: false, recentText: `turn ${message.turn} missing record saving...`, mode: "pending" });
      } else if (message.type === "INVALID_SNAPSHOT") {
        renderStatus({ waiting: false, recentText: `turn ${message.turn} invalid snapshot`, mode: "error" });
        showNotice("Invalid snapshot", message.reason || "invalid marker", "error", false, message.toastKey || `invalid:${message.conversationKey}:${message.turn}:${message.reason}`);
      } else if (message.type === "SAVE_ERROR") {
        const label = /^download_(path|filename)/.test(message.reason || "") ? "download path error" : "save error";
        renderStatus({ waiting: false, recentText: `turn ${message.turn || "-"} ${label}`, mode: "error" });
        showNotice("Save error", message.reason || "download failed", "error", false, `error:${message.conversationKey}:${message.turn}:${message.reason}`);
      } else if (message.type === "QA_DOWNLOAD_STARTED") {
        renderStatus({ waiting: false, recentText: `QA save id ${message.downloadId}`, mode: "pending" });
        shouldRefresh = false;
      } else if (message.type === "QA_DOWNLOAD_COMPLETE") {
        const label = message.filenameMatches === false ? "QA complete: filename mismatch" : "QA save complete";
        renderStatus({ waiting: false, recentText: `${label} ${message.writeId || message.downloadId || ""}`.trim(), mode: message.filenameMatches === false ? "error" : "confirmed" });
        shouldRefresh = false;
      } else if (message.type === "QA_DOWNLOAD_ERROR") {
        renderStatus({ waiting: false, recentText: `QA save error: ${message.reason || "failed"}`, mode: "error" });
        shouldRefresh = false;
      }
      if (shouldRefresh) {
        refreshStatus();
      }
      return undefined;
    });
  }

  async function refreshStatus() {
    if (extensionStale) {
      renderStatus({ recentText: "extension reloaded · refresh tab", mode: "error" });
      return;
    }
    try {
      const response = await sendMessage("GET_STATUS", {});
      if (extensionStale || response.contextInvalidated) {
        renderStatus({ recentText: "extension reloaded · refresh tab", mode: "error" });
        return;
      }
      const status = response.status;
      if (!status) {
        renderStatus({ compactState: "empty", recentText: "waiting for conversation" });
        return;
      }
      const displayTurn = status.displayTurn || status.visibleTurn || status.lastSeenTurn || 0;
      renderStatus({
        compactState: manualRescanActive ? "rescanning" : displayTurn > 0 ? "ready" : "empty",
        conversation: shortConversation(status.conversationKey),
        currentTurn: displayTurn,
        nextTurn: status.nextSnapshotTurn || 10,
        saved: status.savedCount || 0,
        missing: status.missingCount || 0,
        variant: status.variantCount || 0,
        recentText: status.visibleTurn && status.lastSeenTurn && status.visibleTurn < status.lastSeenTurn
          ? `visible turn ${status.visibleTurn}; stored ${status.lastSeenTurn}`
          : status.latest ? `${status.latest.recordType}: ${status.latest.saveState}` : "ready"
      });
    } catch (error) {
      renderStatus({ recentText: String(error?.message || error), mode: "error" });
    }
  }

  function renderStatus(update) {
    if (!floatingBar) {
      return;
    }
    if (update.mode) {
      floatingBar.root.dataset.mode = update.mode;
    }
    if (update.compactState !== undefined) {
      floatingBar.root.dataset.compactState = update.compactState;
    } else if (update.waiting !== undefined) {
      const hasKnownTurn = Number(update.currentTurn || 0) > 0 || Number(floatingBar.turn.textContent || 0) > 0;
      floatingBar.root.dataset.compactState = update.waiting ? "waiting" : hasKnownTurn ? "ready" : "empty";
    }
    if ((update.compactState && update.compactState !== "waiting") || update.waiting === false) {
      window.clearTimeout(waitingTimer);
      waitingTimer = null;
    }
    if (update.conversation !== undefined) {
      floatingBar.conversation.textContent = update.conversation || "-";
    }
    if (update.currentTurn !== undefined) {
      const turnText = Number(update.currentTurn || 0) > 0 ? String(update.currentTurn) : "-";
      floatingBar.turn.textContent = turnText;
      floatingBar.turnDetail.textContent = turnText;
    }
    if (update.nextTurn !== undefined) {
      floatingBar.next.textContent = String(update.nextTurn || "-");
      floatingBar.nextDetail.textContent = `turn ${update.nextTurn || "-"}`;
    }
    if (update.saved !== undefined) {
      const savedText = String(update.saved);
      floatingBar.saved.textContent = savedText;
      floatingBar.rescanSaved.textContent = savedText;
      floatingBar.savedDetail.textContent = savedText;
    }
    if (update.missing !== undefined) {
      floatingBar.missing.textContent = String(update.missing);
    }
    if (update.variant !== undefined) {
      floatingBar.variant.textContent = String(update.variant);
    }
    if (update.recentText !== undefined) {
      floatingBar.recent.textContent = update.recentText;
      floatingBar.status.textContent = update.recentText;
    }
    renderFolderStatus();
  }

  function renderFolderStatus() {
    if (!floatingBar) {
      return;
    }
    const label = getFolderStatusLabel();
    floatingBar.folderDetail.textContent = saveDirectoryName ? `${label}: ${saveDirectoryName}` : label;
  }

  function getFolderStatusLabel() {
    if (!supportsDirectorySave()) {
      return "folder unsupported";
    }
    if (saveDirectoryHandle) {
      return "folder ready";
    }
    return "folder needed";
  }

  function showNotice(title, message, kind, autoClose, toastKey) {
    pruneRegistry(dismissedToasts, DISMISSED_TOAST_TTL_MS, DISMISSED_TOAST_LIMIT);
    const key = toastKey || `${kind}:${title}:${message}`;
    const dismissed = dismissedToasts.has(key);
    debugLog("[SK toast]", { toastKey: key, dismissed, created: false });
    if (dismissed || activeToasts.has(key)) {
      return;
    }
    const notice = document.createElement("aside");
    notice.className = `snapshot-keeper-notice ${kind}`;
    notice.innerHTML = `
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(message)}</span>
      <button type="button" aria-label="Close">x</button>
    `;
    notice.querySelector("button").addEventListener("click", () => {
      dismissedToasts.set(key, Date.now());
      activeToasts.delete(key);
      notice.remove();
    });
    (document.body || document.documentElement).appendChild(notice);
    activeToasts.set(key, notice);
    debugLog("[SK toast]", { toastKey: key, dismissed: false, created: true });
    if (autoClose) {
      window.setTimeout(() => {
        activeToasts.delete(key);
        notice.remove();
      }, 4000);
    }
  }

  function buildEventKey(binding, parsed, eventType, reason) {
    const hash = parsed.markerStatus.markerHash || parsed.normalizedTextHash || "nohash";
    return `${binding.conversationKey || "unknown"}:${parsed.turn || "noturn"}:${eventType}:${reason || "none"}:${hash}`;
  }

  function markEventForProcessing(eventKey) {
    pruneRegistry(processedEvents, PROCESSED_EVENT_TTL_MS, PROCESSED_EVENT_LIMIT);
    if (processedEvents.has(eventKey)) {
      return false;
    }
    processedEvents.set(eventKey, Date.now());
    return true;
  }

  function pruneRegistry(registry, ttlMs, limit) {
    const now = Date.now();
    for (const [key, createdAt] of registry.entries()) {
      if (now - createdAt > ttlMs) {
        registry.delete(key);
      }
    }
    while (registry.size > limit) {
      const oldestKey = registry.keys().next().value;
      registry.delete(oldestKey);
    }
  }

  function normalizeForEventKey(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  }

  function readDebugFlag() {
    try {
      return globalThis.localStorage?.getItem("snapshotKeeperDebug") === "1";
    } catch {
      return false;
    }
  }

  function debugLog(label, payload) {
    if (DEBUG) {
      console.debug(label, payload);
    }
  }

  function shortConversation(conversationKey) {
    return String(conversationKey || "-").split(":").pop().slice(0, 18);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function sendMessage(type, payload) {
    if (extensionStale) {
      return Promise.resolve({ ok: false, contextInvalidated: true, status: null, context: null });
    }
    try {
      return chrome.runtime.sendMessage({ type, ...payload && { payload } })
        .then((response) => {
          if (!response?.ok) {
            throw new Error(response?.error || "Extension message failed");
          }
          return response;
        })
        .catch((error) => {
          if (isExtensionContextInvalidated(error)) {
            handleExtensionContextInvalidated(error);
            return { ok: false, contextInvalidated: true, status: null, context: null };
          }
          throw error;
        });
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        handleExtensionContextInvalidated(error);
        return Promise.resolve({ ok: false, contextInvalidated: true, status: null, context: null });
      }
      return Promise.reject(error);
    }
  }

  function handleAsyncError(error) {
    if (isExtensionContextInvalidated(error)) {
      handleExtensionContextInvalidated(error);
      return;
    }
    console.error("[Snapshot Keeper]", error);
  }

  function isExtensionContextInvalidated(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function handleExtensionContextInvalidated(error) {
    if (extensionStale) {
      return;
    }
    extensionStale = true;
    debugLog("[SK event]", {
      eventKey: "extension_context_invalidated",
      alreadyProcessed: false,
      error: String(error?.message || error || "")
    });
    window.clearTimeout(refreshTimer);
    window.clearTimeout(anchorTimer);
    window.clearTimeout(waitingTimer);
    window.clearTimeout(rescanEndTimer);
    window.clearInterval(watchdogTimer);
    for (const timer of pendingTimers) {
      window.clearTimeout(timer);
    }
    pendingTimers.clear();
    observer?.disconnect();
    observer = null;
    renderStatus({ recentText: "extension reloaded · refresh tab", mode: "error" });
  }
})();
