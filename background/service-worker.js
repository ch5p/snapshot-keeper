const STORAGE_KEY = "snapshotKeeperState";
const LEGACY_DOWNLOAD_ROOT = "ChatGPT-Snapshots";
const PATH_SCHEMA_VERSION = 2;
const SNAPSHOT_SECTIONS = [
  "### 현재 진행 중인 주제",
  "### 새로 확정된 사항",
  "### 미확정 사항",
  "### 제외된 주제 (1회 기록)",
  "### 앞으로 할 일"
];
const BODY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ERROR_BODIES = 20;
const DEBUG = true;

let writerQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  withState(async (state) => state);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && isChatGptUrl(details.url)) {
    enqueueWriter(() => updateTabContext(details.tabId, details.url, "navigation_committed"));
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0 && isChatGptUrl(details.url)) {
    enqueueWriter(() => updateTabContext(details.tabId, details.url, "history_state_updated"));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => {
      console.error("[Snapshot Keeper]", error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
  return true;
});

async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;
  if (!message || !message.type) {
    throw new Error("Invalid message");
  }

  if (message.type === "GET_CONTEXT") {
    const context = await enqueueWriter(() => updateTabContext(tabId, message.url, "content_context"));
    return { context };
  }

  if (message.type === "GET_STATUS") {
    const state = await readState();
    const context = getTabContextSnapshot(state, tabId);
    return {
      status: getConversationStatus(state, context?.currentConversationKey, context),
      context
    };
  }

  if (message.type === "TURN_SEEN" || message.type === "TURN_OBSERVED") {
    return enqueueWriter(() => recordTurnSeen(tabId, message.payload));
  }

  if (message.type === "SNAPSHOT_CANDIDATE") {
    debugLog("[SK bg] received snapshot_candidate", {
      tabId,
      turn: Number(message.payload?.turn || 0) || null,
      hasSnapshotText: Boolean(message.payload?.snapshotText),
      nodeBindingConversationKey: message.payload?.nodeBinding?.conversationKey || null
    });
    return enqueueWriter(() => handleSnapshotCandidate(tabId, message.payload));
  }

  if (message.type === "MISSING_CANDIDATE") {
    return enqueueWriter(() => handleMissingCandidate(tabId, message.payload));
  }

  if (message.type === "INVALID_SNAPSHOT") {
    return enqueueWriter(() => handleInvalidSnapshot(tabId, message.payload));
  }

  if (message.type === "RETRY_SAVE") {
    return enqueueWriter(() => retrySave(tabId, message.payload));
  }

  if (message.type === "CLEAR_ERRORS") {
    return enqueueWriter(() => clearErrorBodies(tabId));
  }

  if (message.type === "QA_DOWNLOAD_TEST") {
    debugLog("[SK bg] received qa_download_test", {
      tabId,
      url: message.payload?.url || null
    });
    return handleQaDownloadTest(tabId, message.payload);
  }

  throw new Error(`Unsupported message type: ${message.type}`);
}

function enqueueWriter(task) {
  const run = writerQueue.then(task, task);
  writerQueue = run.catch(() => {});
  return run;
}

async function readState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(result[STORAGE_KEY]);
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function withState(mutator) {
  const state = await readState();
  const nextState = await mutator(state);
  await writeState(nextState || state);
  return nextState || state;
}

function normalizeState(state) {
  return {
    schemaVersion: 1,
    tabs: {},
    conversations: {},
    pendingBodies: {},
    events: [],
    lastReconcileAt: null,
    ...(state || {})
  };
}

async function updateTabContext(tabId, url, source) {
  if (typeof tabId !== "number") {
    throw new Error("Missing sender tabId");
  }
  return withState(async (state) => {
    const previous = state.tabs[String(tabId)] || {};
    const resolved = resolveConversationKey(state, tabId, url, previous.currentConversationKey);
    let conversationKey = resolved.conversationKey;

    if (resolved.officialKey && previous.currentConversationKey?.startsWith("chatgpt:tab-")) {
      conversationKey = migrateConversation(state, previous.currentConversationKey, resolved.officialKey);
    }

    const previousPathKey = getPathKey(previous.currentUrl);
    const nextPathKey = getPathKey(url);
    const changed = previousPathKey !== nextPathKey || previous.currentConversationKey !== conversationKey;
    const navigationEpoch = changed ? Number(previous.navigationEpoch || 0) + 1 : Number(previous.navigationEpoch || 1);

    state.tabs[String(tabId)] = {
      tabId,
      currentUrl: url || previous.currentUrl || "",
      currentConversationKey: conversationKey,
      navigationEpoch,
      visibleTurn: changed ? 0 : Number(previous.visibleTurn || 0),
      visibleTurnSource: changed ? null : previous.visibleTurnSource || null,
      visibleTurnSeenAt: changed ? null : previous.visibleTurnSeenAt || null,
      lastSeenAt: nowIso(),
      source
    };

    const conversation = ensureConversation(state, conversationKey, resolved);
    conversation.lastSeenAt = nowIso();
    if (resolved.displayTitle) {
      conversation.displayTitle = resolved.displayTitle;
    }

    appendEvent(state, {
      type: "tab_context_updated",
      tabId,
      conversationKey,
      navigationEpoch,
      source
    });

    return state;
  }).then((state) => getTabContextSnapshot(state, tabId));
}

function resolveConversationKey(state, tabId, url, previousKey) {
  const parsed = parseChatGptUrl(url);
  if (parsed.conversationId) {
    const officialKey = `chatgpt:c-${safeToken(parsed.conversationId, 80)}`;
    return {
      conversationKey: officialKey,
      officialKey,
      conversationId: parsed.conversationId,
      isTemporary: false,
      url: parsed.href,
      displayTitle: null
    };
  }

  const reusableTemporaryKey = previousKey?.startsWith("chatgpt:tab-")
    ? previousKey
    : `chatgpt:tab-${tabId}:local-${Date.now().toString(36)}`;

  return {
    conversationKey: reusableTemporaryKey,
    officialKey: null,
    conversationId: null,
    isTemporary: true,
    url: parsed.href || url || "",
    displayTitle: null
  };
}

function parseChatGptUrl(url) {
  try {
    const parsed = new URL(url || "");
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
    return {
      href: parsed.href,
      conversationId: match ? decodeURIComponent(match[1]) : null
    };
  } catch {
    return { href: url || "", conversationId: null };
  }
}

function isChatGptUrl(url) {
  try {
    const parsed = new URL(url || "");
    return parsed.host === "chatgpt.com" || parsed.host === "chat.openai.com";
  } catch {
    return false;
  }
}

function getPathKey(url) {
  try {
    const parsed = new URL(url || "");
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url || "";
  }
}

function migrateConversation(state, temporaryKey, officialKey) {
  if (temporaryKey === officialKey) {
    return officialKey;
  }

  const temporary = state.conversations[temporaryKey];
  const official = state.conversations[officialKey];
  if (!temporary) {
    ensureConversation(state, officialKey, { conversationKey: officialKey, isTemporary: false });
    return officialKey;
  }

  if (!official) {
    state.conversations[officialKey] = {
      ...temporary,
      conversationKey: officialKey,
      previousConversationKeys: [...(temporary.previousConversationKeys || []), temporaryKey],
      isTemporary: false
    };
  } else {
    state.conversations[officialKey] = mergeConversations(official, temporary, temporaryKey);
  }
  normalizeConversationFolderPathForKey(state.conversations[officialKey], temporaryKey);

  state.pendingBodies = Object.fromEntries(
    Object.entries(state.pendingBodies || {}).map(([key, body]) => {
      if (body.conversationKey !== temporaryKey) {
        return [key, body];
      }
      const nextBody = { ...body, conversationKey: officialKey };
      if (!folderPathMatchesConversationKey(officialKey, body.filePath)) {
        delete nextBody.filePath;
      }
      return [bodyStorageKey(officialKey, body.turn, body.normalizedHash || "pending"), nextBody];
    })
  );

  delete state.conversations[temporaryKey];
  appendEvent(state, {
    type: "conversation_key_migrated",
    from: temporaryKey,
    to: officialKey
  });
  return officialKey;
}

function mergeConversations(target, source, sourceKey) {
  const turns = { ...(source.turns || {}), ...(target.turns || {}) };
  return {
    ...source,
    ...target,
    conversationKey: target.conversationKey,
    savedTurns: uniqueNumbers([...(source.savedTurns || []), ...(target.savedTurns || [])]),
    missingTurns: uniqueNumbers([...(source.missingTurns || []), ...(target.missingTurns || [])]),
    variantTurns: uniqueNumbers([...(source.variantTurns || []), ...(target.variantTurns || [])]),
    lastSeenTurn: Math.max(Number(source.lastSeenTurn || 0), Number(target.lastSeenTurn || 0)),
    turns,
    previousConversationKeys: uniqueStrings([...(target.previousConversationKeys || []), ...(source.previousConversationKeys || []), sourceKey])
  };
}

function ensureConversation(state, conversationKey, resolved = {}) {
  if (!state.conversations[conversationKey]) {
    state.conversations[conversationKey] = {
      conversationKey,
      conversationId: resolved.conversationId || null,
      createdAt: nowIso(),
      displayTitle: "untitled",
      lastSeenAt: nowIso(),
      lastSeenTurn: 0,
      savedTurns: [],
      missingTurns: [],
      variantTurns: [],
      turns: {},
      isTemporary: Boolean(resolved.isTemporary)
    };
  }
  return state.conversations[conversationKey];
}

async function recordTurnSeen(tabId, payload) {
  return withState(async (state) => {
    const bindingCheck = validateTurnBinding(state, tabId, payload?.nodeBinding);
    if (!bindingCheck.ok) {
      appendEvent(state, {
        type: "turn_seen_rejected",
        tabId,
        reason: bindingCheck.reason
      });
      return state;
    }

    const conversation = ensureConversation(state, bindingCheck.conversationKey);
    updateVisibleTurn(state, tabId, bindingCheck.conversationKey, Number(payload.turn), payload.source || null);
    updateLastSeenTurn(state, conversation, Number(payload.turn), tabId);
    appendEvent(state, {
      type: "turn_seen",
      conversationKey: conversation.conversationKey,
      tabId,
      turn: Number(payload.turn),
      source: payload.source || null,
      sourceSingle: payload.nodeBinding?.isAssistantSingleNode === true
    });
    return state;
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId)
  }));
}

async function handleSnapshotCandidate(tabId, payload) {
  let snapshotResult = {
    turn: Number(payload?.turn || 0) || null,
    saveStateAfter: "not_processed",
    reason: null,
    downloadCalled: false
  };
  return withState(async (state) => {
    const bindingCheck = validateBinding(state, tabId, payload?.nodeBinding);
    if (!bindingCheck.ok) {
      snapshotResult = {
        turn: Number(payload?.turn || 0) || null,
        saveStateAfter: "save_error",
        reason: bindingCheck.reason,
        downloadCalled: false
      };
      debugLog("[SK bg] saveStateAfter", {
        ...snapshotResult
      });
      recordSaveError(state, tabId, payload, bindingCheck.reason);
      return state;
    }

    const turn = Number(payload.turn);
    const snapshotText = String(payload.snapshotText || "");
    const rawHash = await sha256(snapshotText);
    const normalizedHash = await sha256(normalizeSnapshotForHash(snapshotText));
    const conversation = ensureConversation(state, bindingCheck.conversationKey);
    updateLastSeenTurn(state, conversation, turn, tabId);

    const existing = conversation.turns[String(turn)];
    const duplicate = findExistingHashRecord(existing, normalizedHash);
    if (duplicate && ["save_pending", "save_confirmed", "save_error"].includes(duplicate.saveState)) {
      appendEvent(state, {
        type: "duplicate_ignored",
        conversationKey: conversation.conversationKey,
        turn,
        normalizedHash,
        existingState: duplicate.saveState
      });
      snapshotResult = {
        conversationKey: conversation.conversationKey,
        turn,
        saveStateAfter: "duplicate_ignored",
        reason: "duplicate_processed",
        existingState: duplicate.saveState,
        downloadCalled: false
      };
      debugLog("[SK bg] saveStateAfter", {
        ...snapshotResult
      });
      return state;
    }

    const isVariant = Boolean(existing?.normalizedHash && existing.normalizedHash !== normalizedHash);
    const bodyKey = bodyStorageKey(conversation.conversationKey, turn, normalizedHash);
    const filePath = buildSnapshotPath(conversation, turn, isVariant ? "variant" : "saved", normalizedHash);
    const markdown = buildSavedMarkdown({
      conversation,
      turn,
      status: isVariant ? "variant" : "saved",
      rawHash,
      normalizedHash,
      filePath,
      snapshotText,
      binding: payload.nodeBinding
    });

    state.pendingBodies[bodyKey] = {
      conversationKey: conversation.conversationKey,
      turn,
      normalizedHash,
      rawHash,
      snapshotText,
      filePath,
      downloadId: null,
      createdAt: nowIso(),
      lastError: null
    };

    if (state.downloadPathBroken) {
      appendEvent(state, {
        type: "legacy_download_path_block_cleared",
        conversationKey: conversation.conversationKey,
        turn,
        previous: state.downloadPathBroken
      });
      delete state.downloadPathBroken;
    }

    let writeResult;
    try {
      writeResult = await writeSnapshotFileToTab(tabId, filePath, markdown);
    } catch (error) {
      const reason = String(error?.message || error || "file_system_write_failed");
      const errorRecord = {
        turn,
        recordType: isVariant ? "variant" : "snapshot",
        saveState: "save_error",
        normalizedHash,
        rawHash,
        downloadId: null,
        filePath,
        error: reason,
        timestamps: {
          detectedAt: payload.detectedAt || nowIso(),
          errorAt: nowIso()
        },
        variants: existing?.variants || []
      };
      if (isVariant) {
        existing.variants = [...(existing.variants || []), errorRecord];
        conversation.variantTurns = uniqueNumbers([...(conversation.variantTurns || []), turn]);
      } else {
        conversation.turns[String(turn)] = errorRecord;
      }
      state.pendingBodies[bodyKey].lastError = reason;
      state.pendingBodies[bodyKey].errorAt = nowIso();
      appendEvent(state, {
        type: "save_error",
        conversationKey: conversation.conversationKey,
        turn,
        normalizedHash,
        rawHash,
        filePath,
        reason
      });
      notifyTab(tabId, {
        type: "SAVE_ERROR",
        conversationKey: conversation.conversationKey,
        turn,
        reason
      });
      snapshotResult = {
        conversationKey: conversation.conversationKey,
        turn,
        saveStateAfter: "save_error",
        reason,
        downloadCalled: false,
        writer: "file_system_access",
        filePath
      };
      debugLog("[SK bg] saveStateAfter", {
        ...snapshotResult
      });
      return prunePendingBodies(state);
    }
    const turnRecord = {
      turn,
      recordType: isVariant ? "variant" : "snapshot",
      saveState: "save_confirmed",
      normalizedHash,
      rawHash,
      downloadId: null,
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath,
      writer: writeResult.writer,
      timestamps: {
        detectedAt: payload.detectedAt || nowIso(),
        confirmedAt: nowIso()
      },
      variants: existing?.variants || []
    };

    if (isVariant) {
      const variantRecord = {
        turn,
        recordType: "variant",
        saveState: "save_confirmed",
        normalizedHash,
        rawHash,
        downloadId: null,
        writeId: writeResult.writeId,
        filePath,
        actualPath: writeResult.actualPath,
        writer: writeResult.writer,
        variantOf: existing.filePath || null,
        variantIndex: (existing.variants || []).length + 1,
        timestamps: {
          detectedAt: payload.detectedAt || nowIso(),
          confirmedAt: nowIso()
        }
      };
      existing.variants = [...(existing.variants || []), variantRecord];
      existing.timestamps = {
        ...(existing.timestamps || {}),
        variantConfirmedAt: nowIso()
      };
      conversation.variantTurns = uniqueNumbers([...(conversation.variantTurns || []), turn]);
    } else {
      conversation.turns[String(turn)] = turnRecord;
      conversation.savedTurns = uniqueNumbers([...(conversation.savedTurns || []), turn]);
    }
    delete state.pendingBodies[bodyKey];

    appendEvent(state, {
      type: isVariant ? "variant_save_confirmed" : "snapshot_save_confirmed",
      conversationKey: conversation.conversationKey,
      turn,
      normalizedHash,
      rawHash,
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath
    });

    snapshotResult = {
      conversationKey: conversation.conversationKey,
      turn,
      saveStateAfter: "save_confirmed",
      downloadCalled: false,
      writer: "file_system_access",
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath,
      variant: isVariant
    };

    debugLog("[SK bg] saveStateAfter", {
      ...snapshotResult
    });

    notifyTab(tabId, {
      type: "SAVE_CONFIRMED",
      turn,
      conversationKey: conversation.conversationKey,
      filePath,
      actualPath: writeResult.actualPath,
      variant: isVariant
    });

    return prunePendingBodies(state);
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId),
    snapshotResult
  }));
}

function findExistingHashRecord(turnRecord, normalizedHash) {
  if (!turnRecord || !normalizedHash) {
    return null;
  }
  if (turnRecord.normalizedHash === normalizedHash) {
    return turnRecord;
  }
  return (turnRecord.variants || []).find((variant) => variant.normalizedHash === normalizedHash) || null;
}

async function handleMissingCandidate(tabId, payload) {
  return withState(async (state) => {
    const bindingCheck = validateBinding(state, tabId, payload?.nodeBinding);
    if (!bindingCheck.ok) {
      recordSaveError(state, tabId, payload, bindingCheck.reason);
      return state;
    }

    const turn = Number(payload.turn);
    const conversation = ensureConversation(state, bindingCheck.conversationKey);
    updateLastSeenTurn(state, conversation, turn, tabId);
    const filePath = buildSnapshotPath(conversation, turn, "missing", "missing");
    const markdown = buildMissingMarkdown({
      conversation,
      turn,
      filePath,
      markerStatus: payload.markerStatus,
      missingSections: payload.missingSections || [],
      reason: payload.reason || "snapshot_markers_or_sections_missing",
      binding: payload.nodeBinding
    });
    let writeResult;
    try {
      writeResult = await writeSnapshotFileToTab(tabId, filePath, markdown);
    } catch (error) {
      const reason = String(error?.message || error || "file_system_write_failed");
      conversation.turns[String(turn)] = {
        turn,
        recordType: "missing",
        saveState: "save_error",
        normalizedHash: null,
        rawHash: null,
        downloadId: null,
        filePath,
        markerStatus: payload.markerStatus || {},
        missingSections: payload.missingSections || [],
        reason,
        timestamps: {
          detectedAt: payload.detectedAt || nowIso(),
          errorAt: nowIso()
        }
      };
      appendEvent(state, {
        type: "save_error",
        conversationKey: conversation.conversationKey,
        turn,
        filePath,
        reason
      });
      notifyTab(tabId, {
        type: "SAVE_ERROR",
        turn,
        conversationKey: conversation.conversationKey,
        reason
      });
      return state;
    }

    conversation.turns[String(turn)] = {
      turn,
      recordType: "missing",
      saveState: "save_confirmed",
      normalizedHash: null,
      rawHash: null,
      downloadId: null,
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath,
      writer: writeResult.writer,
      markerStatus: payload.markerStatus || {},
      missingSections: payload.missingSections || [],
      reason: payload.reason || "snapshot_markers_or_sections_missing",
      timestamps: {
        detectedAt: payload.detectedAt || nowIso(),
        confirmedAt: nowIso()
      }
    };
    conversation.missingTurns = uniqueNumbers([...(conversation.missingTurns || []), turn]);

    appendEvent(state, {
      type: "missing_save_confirmed",
      conversationKey: conversation.conversationKey,
      turn,
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath
    });

    notifyTab(tabId, {
      type: "SAVE_CONFIRMED",
      turn,
      conversationKey: conversation.conversationKey,
      filePath,
      actualPath: writeResult.actualPath
    });

    return state;
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId)
  }));
}

async function handleInvalidSnapshot(tabId, payload) {
  return withState(async (state) => {
    const bindingCheck = validateBinding(state, tabId, payload?.nodeBinding);
    if (!bindingCheck.ok) {
      recordSaveError(state, tabId, payload, bindingCheck.reason);
      return state;
    }
    const conversationKey = bindingCheck.conversationKey || payload?.nodeBinding?.conversationKey || "unknown";
    const conversation = ensureConversation(state, conversationKey);
    const turn = Number(payload.turn);
    const existing = conversation.turns[String(turn)];
    if (existing?.recordType === "invalid_snapshot" && existing.eventKey && existing.eventKey === payload.eventKey) {
      appendEvent(state, {
        type: "invalid_snapshot_duplicate_ignored",
        conversationKey,
        turn,
        eventKey: payload.eventKey
      });
      return state;
    }
    updateLastSeenTurn(state, conversation, turn, tabId);
    conversation.turns[String(turn)] = {
      turn,
      recordType: "invalid_snapshot",
      saveState: "invalid_snapshot",
      normalizedHash: null,
      rawHash: null,
      downloadId: null,
      filePath: null,
      markerStatus: payload.markerStatus || {},
      reason: payload.reason || "invalid_snapshot_marker",
      eventKey: payload.eventKey || null,
      timestamps: {
        detectedAt: payload.detectedAt || nowIso()
      }
    };
    appendEvent(state, {
      type: "invalid_snapshot",
      conversationKey,
      turn,
      reason: payload.reason || "invalid_snapshot_marker",
      markerStatus: payload.markerStatus || {},
      eventKey: payload.eventKey || null
    });
    notifyTab(tabId, {
      type: "INVALID_SNAPSHOT",
      turn,
      conversationKey,
      reason: payload.reason || "invalid_snapshot_marker",
      toastKey: payload.toastKey || payload.eventKey || null
    });
    return state;
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId)
  }));
}

async function retrySave(tabId, payload) {
  return withState(async (state) => {
    const context = getTabContextSnapshot(state, tabId);
    const conversationKey = payload?.conversationKey || context?.currentConversationKey;
    const turn = Number(payload?.turn);
    const conversation = state.conversations[conversationKey];
    if (!conversation || !turn) {
      throw new Error("Missing retry target");
    }

    const body = Object.values(state.pendingBodies || {}).find((entry) => {
      return entry.conversationKey === conversationKey && Number(entry.turn) === turn;
    });
    if (!body?.snapshotText) {
      throw new Error("No pending/error body available for manual retry");
    }

    const filePath = body.filePath && folderPathMatchesConversation(conversation, body.filePath)
      ? body.filePath
      : buildSnapshotPath(conversation, turn, "saved", body.normalizedHash);
    const markdown = buildSavedMarkdown({
      conversation,
      turn,
      status: "saved",
      rawHash: body.rawHash,
      normalizedHash: body.normalizedHash,
      filePath,
      snapshotText: body.snapshotText,
      binding: { conversationKey }
    });
    let writeResult;
    try {
      writeResult = await writeSnapshotFileToTab(tabId, filePath, markdown);
    } catch (error) {
      const reason = String(error?.message || error || "file_system_write_failed");
      body.filePath = filePath;
      body.lastError = reason;
      body.errorAt = nowIso();
      conversation.turns[String(turn)] = {
        ...(conversation.turns[String(turn)] || {}),
        turn,
        saveState: "save_error",
        error: reason,
        filePath,
        timestamps: {
          ...(conversation.turns[String(turn)]?.timestamps || {}),
          errorAt: nowIso()
        }
      };
      appendEvent(state, {
        type: "save_error",
        conversationKey,
        turn,
        filePath,
        reason
      });
      notifyTab(tabId, { type: "SAVE_ERROR", turn, conversationKey, reason });
      return prunePendingBodies(state);
    }
    body.filePath = filePath;
    body.lastError = null;
    body.createdAt = nowIso();

    conversation.turns[String(turn)] = {
      ...(conversation.turns[String(turn)] || {}),
      turn,
      saveState: "save_confirmed",
      downloadId: null,
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath,
      writer: writeResult.writer,
      timestamps: {
        ...(conversation.turns[String(turn)]?.timestamps || {}),
        retryConfirmedAt: nowIso(),
        confirmedAt: nowIso()
      }
    };
    deletePendingBodyForConversationTurn(state, conversationKey, turn);
    conversation.savedTurns = uniqueNumbers([...(conversation.savedTurns || []), turn]);

    appendEvent(state, {
      type: "manual_retry_confirmed",
      conversationKey,
      turn,
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath
    });
    notifyTab(tabId, { type: "SAVE_CONFIRMED", turn, conversationKey, filePath, actualPath: writeResult.actualPath });
    return state;
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId)
  }));
}

async function clearErrorBodies(tabId) {
  let clearedDownloadPathBroken = false;
  return withState(async (state) => {
    clearedDownloadPathBroken = Boolean(state.downloadPathBroken);
    state.pendingBodies = Object.fromEntries(
      Object.entries(state.pendingBodies || {}).filter(([, body]) => body.lastError === null)
    );
    delete state.downloadPathBroken;
    appendEvent(state, {
      type: "error_bodies_cleared",
      tabId,
      clearedDownloadPathBroken
    });
    return state;
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId),
    clearedDownloadPathBroken
  }));
}

function validateBinding(state, tabId, binding) {
  if (!binding || !binding.conversationKey) {
    debugLog("[SK binding]", {
      nodeBindingConversationKey: binding?.conversationKey || null,
      currentConversationKey: null,
      stale: null,
      decision: "reject_unresolved_binding"
    });
    return { ok: false, reason: "unresolved_binding" };
  }
  rebindOfficialConversationFromBindingUrl(state, tabId, binding);
  if (binding.isAssistantSingleNode !== true) {
    debugLog("[SK binding]", {
      nodeBindingConversationKey: binding.conversationKey,
      currentConversationKey: null,
      stale: null,
      decision: "reject_source_node_not_single_assistant"
    });
    return { ok: false, reason: "source_node_not_single_assistant" };
  }
  if (!Number.isFinite(Number(binding.navigationEpoch))) {
    debugLog("[SK binding]", {
      nodeBindingConversationKey: binding.conversationKey,
      currentConversationKey: null,
      stale: null,
      decision: "reject_unresolved_capture_epoch"
    });
    return { ok: false, reason: "unresolved_binding" };
  }

  const tab = state.tabs[String(tabId)];
  if (!tab) {
    debugLog("[SK binding]", {
      nodeBindingConversationKey: binding.conversationKey,
      currentConversationKey: null,
      stale: false,
      decision: "use_node_binding_without_current_tab"
    });
    return {
      ok: true,
      reason: "tab_context_missing_but_binding_present",
      conversationKey: binding.conversationKey
    };
  }

  const stale = tab.currentConversationKey !== binding.conversationKey || Number(tab.navigationEpoch) !== Number(binding.navigationEpoch);
  if (stale) {
    appendEvent(state, {
      type: "stale_warning",
      tabId,
      currentConversationKey: tab.currentConversationKey,
      bindingConversationKey: binding.conversationKey,
      currentEpoch: tab.navigationEpoch,
      captureEpoch: binding.navigationEpoch,
      decision: "use_node_binding"
    });
  }
  debugLog("[SK binding]", {
    nodeBindingConversationKey: binding.conversationKey,
    currentConversationKey: tab.currentConversationKey,
    stale,
    decision: "use_node_binding"
  });

  return {
    ok: true,
    conversationKey: binding.conversationKey,
    stale
  };
}

function rebindOfficialConversationFromBindingUrl(state, tabId, binding) {
  const parsed = parseChatGptUrl(binding.url || "");
  if (!parsed.conversationId) {
    return;
  }
  const officialKey = `chatgpt:c-${safeToken(parsed.conversationId, 80)}`;
  if (binding.conversationKey === officialKey) {
    return;
  }
  if (String(binding.conversationKey || "").startsWith("chatgpt:tab-")) {
    binding.conversationKey = migrateConversation(state, binding.conversationKey, officialKey);
  } else {
    ensureConversation(state, officialKey, {
      conversationKey: officialKey,
      conversationId: parsed.conversationId,
      isTemporary: false,
      url: parsed.href
    });
    binding.conversationKey = officialKey;
  }
  const tab = state.tabs[String(tabId)];
  if (tab) {
    tab.currentConversationKey = binding.conversationKey;
    tab.currentUrl = binding.url || tab.currentUrl;
  }
  appendEvent(state, {
    type: "binding_rebound_to_official_conversation",
    tabId,
    conversationKey: binding.conversationKey,
    conversationUrl: binding.url || ""
  });
}

function validateTurnBinding(state, tabId, binding) {
  if (!binding || !binding.conversationKey) {
    return { ok: false, reason: "unresolved_binding" };
  }
  rebindOfficialConversationFromBindingUrl(state, tabId, binding);
  if (binding.isAssistantCandidate !== true) {
    return { ok: false, reason: "source_node_not_assistant_candidate" };
  }

  const tab = state.tabs[String(tabId)];
  if (!tab) {
    return {
      ok: true,
      reason: "tab_context_missing_but_binding_present",
      conversationKey: binding.conversationKey
    };
  }

  if (tab.currentConversationKey !== binding.conversationKey || Number(tab.navigationEpoch) !== Number(binding.navigationEpoch)) {
    appendEvent(state, {
      type: "turn_seen_stale_warning",
      tabId,
      currentConversationKey: tab.currentConversationKey,
      bindingConversationKey: binding.conversationKey,
      currentEpoch: tab.navigationEpoch,
      captureEpoch: binding.navigationEpoch
    });
  }

  return {
    ok: true,
    conversationKey: binding.conversationKey
  };
}

function recordSaveError(state, tabId, payload, reason) {
  const conversationKey = payload?.nodeBinding?.conversationKey || getTabContextSnapshot(state, tabId)?.currentConversationKey || "unknown";
  const conversation = ensureConversation(state, conversationKey);
  const turn = Number(payload?.turn || 0);
  if (turn) {
    conversation.turns[String(turn)] = {
      ...(conversation.turns[String(turn)] || {}),
      turn,
      recordType: "error",
      saveState: "save_error",
      error: reason,
      timestamps: {
        ...(conversation.turns[String(turn)]?.timestamps || {}),
        errorAt: nowIso()
      }
    };
  }
  appendEvent(state, {
    type: "save_error",
    tabId,
    conversationKey,
    turn,
    reason
  });
  notifyTab(tabId, {
    type: "SAVE_ERROR",
    conversationKey,
    turn,
    reason
  });
}

async function handleQaDownloadTest(tabId, payload) {
  const stamp = formatTimestampForPath(new Date());
  const filePath = `_qa/${stamp}__download_test.md`;
  const markdown = [
    "---",
    "status: qa_download_test",
    `detectedAt: ${yamlString(nowIso())}`,
    `filePath: ${yamlString(filePath)}`,
    `sourceUrl: ${yamlString(payload?.url || "")}`,
    "---",
    "",
    "# Snapshot Keeper QA download test",
    "",
    "This file is generated only to test File System Access writer handling.",
    ""
  ].join("\n");
  try {
    const writeResult = await writeSnapshotFileToTab(tabId, filePath, markdown);
    const result = {
      saveStateAfter: "save_confirmed",
      downloadCalled: false,
      writer: "file_system_access",
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath
    };
    debugLog("[SK qa] download test result", result);
    notifyTab(tabId, {
      type: "QA_DOWNLOAD_COMPLETE",
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath,
      filenameMatches: true
    });
    return { qaDownloadResult: result };
  } catch (error) {
    const result = {
      saveStateAfter: "save_error",
      reason: String(error?.message || error || "qa_download_failed"),
      downloadCalled: false,
      writer: "file_system_access",
      filePath
    };
    debugLog("[SK qa] download test result", result);
    notifyTab(tabId, {
      type: "QA_DOWNLOAD_ERROR",
      reason: result.reason,
      filePath
    });
    return { qaDownloadResult: result };
  }
}

async function writeSnapshotFileToTab(tabId, filePath, markdown) {
  assertSafeDownloadPath(filePath);
  if (typeof tabId !== "number") {
    throw new Error("writer_tab_unavailable");
  }
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: "WRITE_SNAPSHOT_FILE",
      payload: {
        filePath,
        markdown
      }
    });
  } catch (error) {
    throw new Error(isMessageContextError(error) ? "writer_context_unavailable" : String(error?.message || error || "writer_message_failed"));
  }
  if (!response?.ok) {
    throw new Error(response?.error || "file_system_write_failed");
  }
  return {
    writeId: createFileWriteId(),
    writer: "file_system_access",
    filePath,
    actualPath: response.actualPath || filePath,
    rootName: response.rootName || ""
  };
}

function createFileWriteId() {
  return `fs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isMessageContextError(error) {
  const message = String(error?.message || error || "");
  return /receiving end does not exist|extension context invalidated|context invalidated/i.test(message);
}

function assertSafeDownloadPath(filePath) {
  const value = String(filePath || "");
  if (!value || value.startsWith(`${LEGACY_DOWNLOAD_ROOT}/`) || /(^|\/)\.\.?(\/|$)/.test(value) || /^[a-z]:/i.test(value) || value.startsWith("/")) {
    throw new Error("unsafe_download_filename");
  }
  const baseName = value.split("/").pop() || "";
  if (/^다운로드(?: \(\d+\))?\.md$/i.test(baseName)) {
    throw new Error("fallback_download_filename_blocked");
  }
}

function buildSnapshotPath(conversation, turn, status, hash) {
  const date = new Date();
  const month = formatDatePart(date).slice(0, 7);
  const stamp = formatTimestampForPath(date);
  const folderPath = ensureConversationFolderPath(conversation, month, stamp);
  const turnPart = `turn_${String(turn).padStart(4, "0")}`;
  if (status === "missing") {
    return `${folderPath}/missing/${turnPart}__${stamp}__missing.md`;
  }
  if (status === "variant") {
    return `${folderPath}/variants/${turnPart}__${safeToken(hash, 10)}__${stamp}__variant.md`;
  }
  return `${folderPath}/${turnPart}__${stamp}__saved.md`;
}

function ensureConversationFolderPath(conversation, month, stamp) {
  const shortId = conversationShortId(conversation.conversationKey);
  if (conversation.folderPathSchema === PATH_SCHEMA_VERSION && conversation.folderPath && folderPathMatchesConversation(conversation, conversation.folderPath)) {
    return conversation.folderPath;
  }
  if (conversation.folderPath) {
    conversation.previousFolderPaths = uniqueStrings([
      ...(conversation.previousFolderPaths || []),
      conversation.folderPath
    ]);
  }
  conversation.folderPath = `${month}/${stamp}__${shortId}`;
  conversation.folderPathSchema = PATH_SCHEMA_VERSION;
  conversation.folderPathConversationKey = conversation.conversationKey;
  debugLog("[SK path] folderPath rebound", {
    conversationKey: conversation.conversationKey,
    folderPath: conversation.folderPath,
    previousFolderPaths: conversation.previousFolderPaths || []
  });
  return conversation.folderPath;
}

function normalizeConversationFolderPathForKey(conversation, previousConversationKey) {
  if (!conversation?.folderPath || (conversation.folderPathSchema === PATH_SCHEMA_VERSION && folderPathMatchesConversation(conversation, conversation.folderPath))) {
    return;
  }
  conversation.previousFolderPaths = uniqueStrings([
    ...(conversation.previousFolderPaths || []),
    conversation.folderPath
  ]);
  delete conversation.folderPath;
  delete conversation.folderPathSchema;
  conversation.folderPathConversationKey = conversation.conversationKey;
  debugLog("[SK path] migrated folderPath cleared", {
    conversationKey: conversation.conversationKey,
    previousConversationKey,
    previousFolderPaths: conversation.previousFolderPaths
  });
}

function folderPathMatchesConversation(conversation, filePath) {
  return folderPathMatchesConversationKey(conversation?.conversationKey, filePath);
}

function folderPathMatchesConversationKey(conversationKey, filePath) {
  if (String(filePath || "").replace(/\\/g, "/").startsWith(`${LEGACY_DOWNLOAD_ROOT}/`)) {
    return false;
  }
  const shortId = conversationShortId(conversationKey);
  const parts = String(filePath || "").replace(/\\/g, "/").split("/");
  const folderSegment = parts.find((part) => part.endsWith(`__${shortId}`));
  return Boolean(folderSegment);
}

function buildSavedMarkdown({ conversation, turn, status, rawHash, normalizedHash, filePath, snapshotText, binding }) {
  return [
    "---",
    `status: ${status}`,
    `conversationKey: ${yamlString(conversation.conversationKey)}`,
    `conversationUrl: ${yamlString(binding?.url || "")}`,
    `turn: ${turn}`,
    `detectedAt: ${yamlString(nowIso())}`,
    `rawHash: ${yamlString(rawHash)}`,
    `normalizedHash: ${yamlString(normalizedHash)}`,
    `filePath: ${yamlString(filePath)}`,
    "---",
    "",
    `# turn ${turn} snapshot`,
    "",
    snapshotText.trim(),
    ""
  ].join("\n");
}

function buildMissingMarkdown({ conversation, turn, filePath, markerStatus, missingSections, reason, binding }) {
  return [
    "---",
    "status: missing",
    `conversationKey: ${yamlString(conversation.conversationKey)}`,
    `conversationUrl: ${yamlString(binding?.url || "")}`,
    `turn: ${turn}`,
    `detectedAt: ${yamlString(nowIso())}`,
    `reason: ${yamlString(reason)}`,
    `filePath: ${yamlString(filePath)}`,
    "markerStatus:",
    `  hasStart: ${Boolean(markerStatus?.hasStart)}`,
    `  hasEnd: ${Boolean(markerStatus?.hasEnd)}`,
    `  markerTurn: ${markerStatus?.markerTurn ?? "null"}`,
    "missingSections:",
    ...((missingSections || []).length ? missingSections.map((section) => `  - ${yamlString(section)}`) : ["  []"]),
    "---",
    "",
    `# turn ${turn} missing snapshot`,
    "",
    "Snapshot body is intentionally not stored for missing records.",
    ""
  ].join("\n");
}

function updateLastSeenTurn(state, conversation, turn, tabId) {
  if (!Number.isFinite(turn) || turn <= 0) {
    return;
  }
  if (turn > Number(conversation.lastSeenTurn || 0)) {
    conversation.lastSeenTurn = turn;
    conversation.nextSnapshotTurn = Math.ceil((turn + 1) / 10) * 10;
    appendEvent(state, {
      type: "last_seen_turn_updated",
      conversationKey: conversation.conversationKey,
      tabId,
      turn
    });
  } else if (turn < Number(conversation.lastSeenTurn || 0)) {
    appendEvent(state, {
      type: "old_turn_seen",
      conversationKey: conversation.conversationKey,
      tabId,
      turn,
      lastSeenTurn: conversation.lastSeenTurn
    });
  }
}

function updateVisibleTurn(state, tabId, conversationKey, turn, source) {
  if (!Number.isFinite(turn) || turn <= 0 || typeof tabId !== "number") {
    return;
  }
  const tab = state.tabs[String(tabId)];
  if (!tab || tab.currentConversationKey !== conversationKey) {
    appendEvent(state, {
      type: "visible_turn_rejected",
      tabId,
      conversationKey,
      turn,
      reason: "tab_context_mismatch",
      tabConversationKey: tab?.currentConversationKey || null
    });
    return;
  }
  tab.visibleTurn = turn;
  tab.visibleTurnSource = source || null;
  tab.visibleTurnSeenAt = nowIso();
  appendEvent(state, {
    type: "visible_turn_updated",
    conversationKey,
    tabId,
    turn,
    source: source || null
  });
}

function getTabConversationStatus(state, tabId) {
  const context = getTabContextSnapshot(state, tabId);
  return getConversationStatus(state, context?.currentConversationKey, context);
}

function getConversationStatus(state, conversationKey, tabContext = null) {
  const conversation = conversationKey ? state.conversations?.[conversationKey] : null;
  if (!conversation) {
    return null;
  }
  const turns = Object.values(conversation.turns || {});
  const latest = turns.sort((a, b) => {
    return String(b.timestamps?.confirmedAt || b.timestamps?.pendingAt || b.timestamps?.detectedAt || "").localeCompare(
      String(a.timestamps?.confirmedAt || a.timestamps?.pendingAt || a.timestamps?.detectedAt || "")
    );
  })[0] || null;

  const visibleTurn = tabContext?.currentConversationKey === conversation.conversationKey
    ? Number(tabContext.visibleTurn || 0)
    : 0;
  const displayTurn = visibleTurn || Number(conversation.lastSeenTurn || 0);

  return {
    conversationKey: conversation.conversationKey,
    displayTitle: conversation.displayTitle,
    lastSeenTurn: conversation.lastSeenTurn || 0,
    visibleTurn,
    visibleTurnSource: tabContext?.visibleTurnSource || null,
    visibleTurnSeenAt: tabContext?.visibleTurnSeenAt || null,
    displayTurn,
    nextSnapshotTurn: nextSnapshotTurn(displayTurn),
    storedNextSnapshotTurn: conversation.nextSnapshotTurn || nextSnapshotTurn(conversation.lastSeenTurn || 0),
    savedCount: (conversation.savedTurns || []).length,
    missingCount: (conversation.missingTurns || []).length,
    variantCount: (conversation.variantTurns || []).length,
    latest,
    folderPath: conversation.folderPath || null
  };
}

function getTabContextSnapshot(state, tabId) {
  if (typeof tabId !== "number") {
    return null;
  }
  return state.tabs[String(tabId)] || null;
}

function deletePendingBodyForConversationTurn(state, conversationKey, turn) {
  for (const [key, body] of Object.entries(state.pendingBodies || {})) {
    if (body.conversationKey === conversationKey && Number(body.turn) === Number(turn)) {
      delete state.pendingBodies[key];
    }
  }
}

function prunePendingBodies(state) {
  const now = Date.now();
  const entries = Object.entries(state.pendingBodies || {}).filter(([, body]) => {
    if (!body.lastError) {
      return true;
    }
    const created = Date.parse(body.errorAt || body.createdAt || 0);
    return Number.isFinite(created) && now - created < BODY_TTL_MS;
  });

  const errorEntries = entries
    .filter(([, body]) => body.lastError)
    .sort((a, b) => Date.parse(b[1].errorAt || b[1].createdAt || 0) - Date.parse(a[1].errorAt || a[1].createdAt || 0));
  const keepErrorKeys = new Set(errorEntries.slice(0, MAX_ERROR_BODIES).map(([key]) => key));

  state.pendingBodies = Object.fromEntries(entries.filter(([key, body]) => !body.lastError || keepErrorKeys.has(key)));
  return state;
}

function notifyConversationTabs(state, conversationKey, message) {
  for (const tab of Object.values(state.tabs || {})) {
    if (tab.currentConversationKey === conversationKey) {
      notifyTab(tab.tabId, message);
    }
  }
}

function notifyTab(tabId, message) {
  if (typeof tabId !== "number") {
    return;
  }
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function appendEvent(state, event) {
  state.events = [
    ...(state.events || []),
    {
      time: nowIso(),
      ...event
    }
  ].slice(-500);
}

function nextSnapshotTurn(turn) {
  const numeric = Number(turn || 0);
  return Math.ceil((numeric + 1) / 10) * 10 || 10;
}

function normalizeSnapshotForHash(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n?대한민국 기준 시각:\s*\d{4}\.\d{2}\.\d{2}\([^)]+\)\s*\d{2}:\d{2}\s*$/u, "")
    .trim();
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function textToDataUrl(text, mimeType) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function bodyStorageKey(conversationKey, turn, normalizedHash) {
  return `${conversationKey}::${turn}::${normalizedHash}`;
}

function conversationShortId(conversationKey) {
  const last = String(conversationKey || "unknown").split(":").pop() || "unknown";
  return safeToken(last, 24);
}

function safeToken(value, maxLength = 80) {
  const cleaned = String(value || "untitled")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return cleaned || "untitled";
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function nowIso() {
  return new Date().toISOString();
}

function debugLog(label, payload) {
  if (DEBUG) {
    console.debug(label, payload);
  }
}

function formatDatePart(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function formatTimestampForPath(date) {
  return `${formatDatePart(date)}_${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
}
