const STORAGE_KEY = "snapshotKeeperState";
const LEGACY_DOWNLOAD_ROOT = "ChatGPT-Snapshots";
const DEFAULT_ARCHIVE_ROOT = "D:/_my_tools/ChatGPT_Snapshot_Archive";
const DEFAULT_ARCHIVE_FOLDER = `${DEFAULT_ARCHIVE_ROOT}/archive`;
const PATH_SCHEMA_VERSION = 2;
const APP_VERSION = chrome.runtime.getManifest?.().version || "unknown";
const GIT_COMMIT = null;
const TEST_MODE = null;
const UI_STATE = null;
const FILE_WRITER = "file_system_access";
const SNAPSHOT_SECTIONS = [
  "### 현재 진행 중인 주제",
  "### 새로 확정된 사항",
  "### 미확정 사항",
  "### 제외된 주제",
  "### 앞으로 할 일"
];
const BODY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ERROR_BODIES = 20;
const AUTO_GUARD_WINDOW_MS = 60 * 1000;
const AUTO_GUARD_PATH_CHURN_LIMIT = 5;
const AUTO_GUARD_REPEAT_TURN_LIMIT = 5;
const AUTO_GUARD_STALE_LIMIT = 3;
const AUTO_GUARD_MISSING_LIMIT = 2;
const DEBUG = false;

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
    const context = await enqueueWriter(() => updateTabContext(tabId, getMessageUrl(message), "content_context"));
    const state = await readState();
    return {
      context,
      status: getConversationStatus(state, context?.currentConversationKey, context)
    };
  }

  if (message.type === "GET_STATUS") {
    let state = await readState();
    let context = getTabContextSnapshot(state, tabId);
    const url = getMessageUrl(message);
    if (url && (!context || getPathKey(context.currentUrl) !== getPathKey(url))) {
      context = await enqueueWriter(() => updateTabContext(tabId, url, "status_context"));
      state = await readState();
    }
    return {
      status: getConversationStatus(state, context?.currentConversationKey, context),
      context
    };
  }

  if (message.type === "CLEAR_AUTO_GUARD") {
    const url = getMessageUrl(message);
    if (url) {
      await enqueueWriter(() => updateTabContext(tabId, url, "auto_guard_clear_context"));
    }
    return enqueueWriter(() => clearAutoCaptureGuard(tabId));
  }

  if (message.type === "OPEN_ARCHIVE_FOLDER") {
    return openArchiveFolder();
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

  if (message.type === "ESCAPE_SNAPSHOT") {
    return enqueueWriter(() => handleEscapeSnapshot(tabId, message.payload));
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

function getMessageUrl(message) {
  return message?.url || message?.payload?.url || "";
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
    if (shouldIgnoreNavigationContextUpdate(previous, url, source)) {
      appendEvent(state, {
        type: "stale_navigation_context_ignored",
        tabId,
        previousConversationKey: previous.currentConversationKey || null,
        previousUrl: previous.currentUrl || "",
        incomingUrl: url || "",
        previousSource: previous.source || null,
        incomingSource: source || null
      });
      return state;
    }
    const resolved = resolveConversationKey(state, tabId, url, previous.currentConversationKey);
    let conversationKey = resolved.conversationKey;

    if (resolved.officialKey && previous.currentConversationKey?.startsWith("chatgpt:tab-")) {
      conversationKey = migrateConversation(state, previous.currentConversationKey, resolved.officialKey);
    }

    const previousPathKey = getPathKey(previous.currentUrl);
    const nextPathKey = getPathKey(url);
    const pathChanged = previousPathKey !== nextPathKey;
    const conversationChanged = previous.currentConversationKey !== conversationKey;
    const navigationEpoch = conversationChanged ? Number(previous.navigationEpoch || 0) + 1 : Number(previous.navigationEpoch || 1);

    state.tabs[String(tabId)] = {
      tabId,
      currentUrl: url || previous.currentUrl || "",
      currentConversationKey: conversationKey,
      navigationEpoch,
      visibleTurn: conversationChanged ? 0 : Number(previous.visibleTurn || 0),
      visibleTurnSource: conversationChanged ? null : previous.visibleTurnSource || null,
      visibleTurnSeenAt: conversationChanged ? null : previous.visibleTurnSeenAt || null,
      visibleTurnSyncPending: conversationChanged ? true : Boolean(previous.visibleTurnSyncPending && !Number(previous.visibleTurn || 0)),
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
      source,
      pathChanged,
      conversationChanged
    });
    updateAutoCaptureGuard(state, conversation, {
      type: "context",
      tabId,
      source,
      pathChanged,
      conversationChanged
    });

    return state;
  }).then((state) => getTabContextSnapshot(state, tabId));
}

function shouldIgnoreNavigationContextUpdate(previous, incomingUrl, source) {
  if (!source || !String(source).startsWith("navigation_")) {
    return false;
  }
  if (!["content_context", "status_context"].includes(previous?.source)) {
    return false;
  }
  const previousParsed = parseChatGptUrl(previous.currentUrl || "");
  const incomingParsed = parseChatGptUrl(incomingUrl || "");
  if (!previousParsed.conversationId || !incomingParsed.conversationId) {
    return false;
  }
  return previousParsed.conversationId !== incomingParsed.conversationId;
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

  if (previousKey) {
    return {
      conversationKey: previousKey,
      officialKey: previousKey.startsWith("chatgpt:c-") ? previousKey : null,
      conversationId: null,
      isTemporary: previousKey.startsWith("chatgpt:tab-"),
      url: parsed.href || url || "",
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
  if (official?.previousConversationKeys?.includes(temporaryKey)) {
    if (temporary) {
      delete state.conversations[temporaryKey];
    }
    return officialKey;
  }
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
    resolvedMissingTurns: uniqueNumbers([...(source.resolvedMissingTurns || []), ...(target.resolvedMissingTurns || [])]),
    resolvedMissing: {
      ...(source.resolvedMissing || {}),
      ...(target.resolvedMissing || {})
    },
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
  let turnSeenResult = {
    turn: Number(payload?.turn || 0) || null,
    saveStateAfter: "not_processed",
    reason: null
  };
  return withState(async (state) => {
    const bindingCheck = validateTurnBinding(state, tabId, payload?.nodeBinding);
    if (!bindingCheck.ok) {
      turnSeenResult = {
        turn: Number(payload?.turn || 0) || null,
        saveStateAfter: "rejected",
        reason: bindingCheck.reason
      };
      appendEvent(state, {
        type: "turn_seen_rejected",
        tabId,
        reason: bindingCheck.reason
      });
      return state;
    }

    const conversation = ensureConversation(state, bindingCheck.conversationKey);
    updateAutoCaptureGuard(state, conversation, {
      type: "turn_seen",
      tabId,
      source: payload.source || null,
      turn: Number(payload.turn)
    });
    if (payload.source === "latest") {
      updateVisibleTurn(state, tabId, bindingCheck.conversationKey, Number(payload.turn), payload.source || null);
    } else {
      appendEvent(state, {
        type: "visible_turn_skipped",
        conversationKey: conversation.conversationKey,
        tabId,
        turn: Number(payload.turn),
        source: payload.source || null,
        reason: "non_live_turn_seen"
      });
    }
    updateLastSeenTurn(state, conversation, Number(payload.turn), tabId);
    appendEvent(state, {
      type: "turn_seen",
      conversationKey: conversation.conversationKey,
      tabId,
      turn: Number(payload.turn),
      source: payload.source || null,
      sourceSingle: payload.nodeBinding?.isAssistantSingleNode === true
    });
    turnSeenResult = {
      conversationKey: conversation.conversationKey,
      turn: Number(payload.turn),
      saveStateAfter: "accepted",
      reason: null
    };
    return state;
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId),
    turnSeenResult
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
      if (isStaleBindingReason(bindingCheck.reason)) {
        snapshotResult = {
          turn: Number(payload?.turn || 0) || null,
          saveStateAfter: "stale_ignored",
          reason: bindingCheck.reason,
          downloadCalled: false
        };
        appendEvent(state, {
          type: "snapshot_candidate_stale_ignored",
          tabId,
          turn: Number(payload?.turn || 0) || null,
          reason: bindingCheck.reason
        });
        updateAutoCaptureGuard(state, ensureConversation(state, payload?.nodeBinding?.conversationKey || "unknown"), {
          type: "stale",
          tabId,
          source: payload?.source || null,
          turn: Number(payload?.turn || 0) || null
        });
        return state;
      }
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
    if (duplicate && ["save_pending", "save_confirmed"].includes(duplicate.saveState)) {
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
    if (duplicate?.saveState === "save_error" && payload.source !== "manual_rescan") {
      appendEvent(state, {
        type: "save_error_auto_retry_blocked",
        conversationKey: conversation.conversationKey,
        turn,
        filePath: duplicate.filePath || null,
        source: payload.source || null,
        error: duplicate.error || null
      });
      snapshotResult = {
        conversationKey: conversation.conversationKey,
        turn,
        saveStateAfter: "save_error_retry_blocked",
        reason: duplicate.error || "previous_save_error",
        existingState: duplicate.saveState,
        downloadCalled: false,
        filePath: duplicate.filePath || null
      };
      debugLog("[SK bg] saveStateAfter", {
        ...snapshotResult
      });
      return state;
    }

    const previousRecord = existing || null;
    const isVariant = Boolean(existing?.normalizedHash && existing.normalizedHash !== normalizedHash);
    const runtimeMetadata = buildRuntimeMetadata(payload.source || null);
    const variantMetadata = isVariant
      ? buildVariantMetadata(existing, turn, payload.source || null)
      : null;
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
      binding: payload.nodeBinding,
      scanMode: payload.source || null,
      variantMetadata
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
        ...runtimeMetadata,
        ...(variantMetadata || {}),
        ...(isVariant ? { variantIndex: (existing.variants || []).length + 1 } : {}),
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
      ...runtimeMetadata,
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
        variantIndex: (existing.variants || []).length + 1,
        ...runtimeMetadata,
        ...(variantMetadata || {}),
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
      markTurnSaved(conversation, turn, previousRecord, payload.source || null);
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

function isStaleBindingReason(reason) {
  return reason === "stale_node_binding";
}

function sameStringList(left, right) {
  const leftValues = (left || []).map(String);
  const rightValues = (right || []).map(String);
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
}

function sameMissingRecord(record, reason, missingSections) {
  return record?.recordType === "missing" &&
    record.saveState === "save_confirmed" &&
    String(record.reason || "") === String(reason || "") &&
    sameStringList(record.missingSections || [], missingSections || []);
}

function removeNumber(values, target) {
  return uniqueNumbers(values || []).filter((value) => value !== Number(target));
}

function markTurnSaved(conversation, turn, previousRecord = null, source = null) {
  conversation.savedTurns = uniqueNumbers([...(conversation.savedTurns || []), turn]);
  if (previousRecord?.recordType === "missing") {
    conversation.missingTurns = removeNumber(conversation.missingTurns || [], turn);
    conversation.resolvedMissingTurns = uniqueNumbers([...(conversation.resolvedMissingTurns || []), turn]);
    conversation.resolvedMissing = {
      ...(conversation.resolvedMissing || {}),
      [String(turn)]: {
        turn,
        previousReason: previousRecord.reason || null,
        previousFilePath: previousRecord.filePath || null,
        resolvedAt: nowIso(),
        resolvedBy: source || "snapshot_candidate"
      }
    };
  }
}

async function handleMissingCandidate(tabId, payload) {
  return withState(async (state) => {
    const bindingCheck = validateBinding(state, tabId, payload?.nodeBinding);
    if (!bindingCheck.ok) {
      if (isStaleBindingReason(bindingCheck.reason)) {
        appendEvent(state, {
          type: "missing_candidate_stale_ignored",
          tabId,
          turn: Number(payload?.turn || 0) || null,
          reason: bindingCheck.reason
        });
        updateAutoCaptureGuard(state, ensureConversation(state, payload?.nodeBinding?.conversationKey || "unknown"), {
          type: "stale",
          tabId,
          source: payload?.source || null,
          turn: Number(payload?.turn || 0) || null
        });
        return state;
      }
      recordSaveError(state, tabId, payload, bindingCheck.reason);
      return state;
    }

    const turn = Number(payload.turn);
    const conversation = ensureConversation(state, bindingCheck.conversationKey);
    const runtimeMetadata = buildRuntimeMetadata(payload.source || null);
    updateAutoCaptureGuard(state, conversation, {
      type: "missing",
      tabId,
      source: payload.source || null,
      turn,
      reason: payload.reason || "snapshot_markers_or_sections_missing"
    });
    updateLastSeenTurn(state, conversation, turn, tabId);
    const reason = payload.reason || "snapshot_markers_or_sections_missing";
    const missingSections = payload.missingSections || [];
    const existing = conversation.turns[String(turn)];

    if (existing?.saveState === "save_confirmed" && existing.recordType !== "missing") {
      appendEvent(state, {
        type: "missing_after_saved_ignored",
        conversationKey: conversation.conversationKey,
        turn,
        reason,
        missingSections
      });
      return state;
    }

    if (sameMissingRecord(existing, reason, missingSections)) {
      existing.timestamps = {
        ...(existing.timestamps || {}),
        repeatedAt: nowIso()
      };
      existing.repeatCount = Number(existing.repeatCount || 1) + 1;
      appendEvent(state, {
        type: "missing_duplicate_ignored",
        conversationKey: conversation.conversationKey,
        turn,
        filePath: existing.filePath || null,
        reason,
        missingSections,
        repeatCount: existing.repeatCount
      });
      notifyTab(tabId, {
        type: "MISSING_CONFIRMED",
        turn,
        conversationKey: conversation.conversationKey,
        filePath: existing.filePath || null,
        actualPath: existing.actualPath || null,
        reason,
        missingSections,
        repeated: true
      });
      return state;
    }

    const filePath = buildSnapshotPath(conversation, turn, "missing", "missing");
    const markdown = buildMissingMarkdown({
      conversation,
      turn,
      filePath,
      markerStatus: payload.markerStatus,
      missingSections,
      reason,
      binding: payload.nodeBinding,
      scanMode: payload.source || null
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
        ...runtimeMetadata,
        markerStatus: payload.markerStatus || {},
        missingSections,
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
      ...runtimeMetadata,
      markerStatus: payload.markerStatus || {},
      missingSections,
      reason,
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
      type: "MISSING_CONFIRMED",
      turn,
      conversationKey: conversation.conversationKey,
      filePath,
      actualPath: writeResult.actualPath,
      reason,
      missingSections
    });

    return state;
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId)
  }));
}

async function handleEscapeSnapshot(tabId, payload) {
  let escapeResult = {
    turn: Number(payload?.turn || 0) || null,
    saveStateAfter: "not_processed",
    reason: null,
    downloadCalled: false
  };
  return withState(async (state) => {
    const bindingCheck = validateTurnBinding(state, tabId, payload?.nodeBinding);
    if (!bindingCheck.ok) {
      escapeResult = {
        turn: Number(payload?.turn || 0) || null,
        saveStateAfter: "save_error",
        reason: bindingCheck.reason,
        downloadCalled: false
      };
      recordSaveError(state, tabId, payload, bindingCheck.reason);
      notifyTab(tabId, {
        type: "ESCAPE_ERROR",
        conversationKey: payload?.nodeBinding?.conversationKey || "unknown",
        turn: Number(payload?.turn || 0) || null,
        reason: bindingCheck.reason
      });
      return state;
    }

    const turn = Number(payload?.turn || 0) || null;
    const assistantText = String(payload?.assistantText || "").trim();
    if (!assistantText) {
      escapeResult = {
        turn,
        saveStateAfter: "save_error",
        reason: "empty_escape_body",
        downloadCalled: false
      };
      return state;
    }

    const conversation = ensureConversation(state, bindingCheck.conversationKey);
    if (turn) {
      updateLastSeenTurn(state, conversation, turn, tabId);
    }
    const rawHash = await sha256(assistantText);
    const normalizedHash = await sha256(normalizeSnapshotForHash(assistantText));
    const duplicate = (conversation.escapeRecords || []).find((record) => (
      Number(record.turn || 0) === Number(turn || 0) &&
      record.normalizedHash === normalizedHash &&
      record.saveState === "save_confirmed"
    ));
    if (duplicate) {
      appendEvent(state, {
        type: "escape_duplicate_ignored",
        conversationKey: conversation.conversationKey,
        turn,
        normalizedHash,
        filePath: duplicate.filePath || null
      });
      escapeResult = {
        conversationKey: conversation.conversationKey,
        turn,
        saveStateAfter: "duplicate_ignored",
        reason: "duplicate_escape_checkpoint",
        downloadCalled: false,
        filePath: duplicate.filePath || null,
        actualPath: duplicate.actualPath || null
      };
      notifyTab(tabId, {
        type: "ESCAPE_CONFIRMED",
        turn,
        conversationKey: conversation.conversationKey,
        filePath: duplicate.filePath || null,
        actualPath: duplicate.actualPath || null,
        duplicate: true
      });
      return state;
    }

    const runtimeMetadata = buildRuntimeMetadata(payload.source || "manual_escape");
    const filePath = buildEscapeSnapshotPath(conversation, turn, normalizedHash);
    const markdown = buildEscapeMarkdown({
      conversation,
      turn,
      rawHash,
      normalizedHash,
      filePath,
      assistantText,
      binding: payload.nodeBinding,
      markerStatus: payload.markerStatus || {},
      turnSource: payload.turnSource || null,
      sourceTextLength: payload.sourceTextLength || assistantText.length,
      truncated: Boolean(payload.truncated),
      scanMode: payload.source || "manual_escape"
    });

    let writeResult;
    try {
      writeResult = await writeSnapshotFileToTab(tabId, filePath, markdown);
    } catch (error) {
      const reason = String(error?.message || error || "file_system_write_failed");
      appendEvent(state, {
        type: "escape_save_error",
        conversationKey: conversation.conversationKey,
        turn,
        normalizedHash,
        rawHash,
        filePath,
        reason
      });
      notifyTab(tabId, {
        type: "ESCAPE_ERROR",
        conversationKey: conversation.conversationKey,
        turn,
        reason
      });
      escapeResult = {
        conversationKey: conversation.conversationKey,
        turn,
        saveStateAfter: "save_error",
        reason,
        downloadCalled: false,
        writer: "file_system_access",
        filePath
      };
      return state;
    }

    const record = {
      turn,
      recordType: "escape",
      saveState: "save_confirmed",
      normalizedHash,
      rawHash,
      downloadId: null,
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath,
      writer: writeResult.writer,
      ...runtimeMetadata,
      turnSource: payload.turnSource || null,
      sourceTextLength: payload.sourceTextLength || assistantText.length,
      truncated: Boolean(payload.truncated),
      reason: "manual_escape",
      timestamps: {
        detectedAt: payload.detectedAt || nowIso(),
        confirmedAt: nowIso()
      }
    };
    conversation.escapeRecords = [...(conversation.escapeRecords || []), record].slice(-100);
    appendEvent(state, {
      type: "escape_save_confirmed",
      conversationKey: conversation.conversationKey,
      turn,
      normalizedHash,
      rawHash,
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath
    });
    notifyTab(tabId, {
      type: "ESCAPE_CONFIRMED",
      turn,
      conversationKey: conversation.conversationKey,
      filePath,
      actualPath: writeResult.actualPath
    });
    escapeResult = {
      conversationKey: conversation.conversationKey,
      turn,
      saveStateAfter: "save_confirmed",
      downloadCalled: false,
      writer: "file_system_access",
      writeId: writeResult.writeId,
      filePath,
      actualPath: writeResult.actualPath
    };
    return state;
  }).then((state) => ({
    status: getTabConversationStatus(state, tabId),
    escapeResult
  }));
}

async function handleInvalidSnapshot(tabId, payload) {
  return withState(async (state) => {
    const bindingCheck = validateBinding(state, tabId, payload?.nodeBinding);
    if (!bindingCheck.ok) {
      if (isStaleBindingReason(bindingCheck.reason)) {
        appendEvent(state, {
          type: "invalid_snapshot_stale_ignored",
          tabId,
          turn: Number(payload?.turn || 0) || null,
          reason: bindingCheck.reason
        });
        updateAutoCaptureGuard(state, ensureConversation(state, payload?.nodeBinding?.conversationKey || "unknown"), {
          type: "stale",
          tabId,
          source: payload?.source || null,
          turn: Number(payload?.turn || 0) || null
        });
        return state;
      }
      recordSaveError(state, tabId, payload, bindingCheck.reason);
      return state;
    }
    const conversationKey = bindingCheck.conversationKey || payload?.nodeBinding?.conversationKey || "unknown";
    const conversation = ensureConversation(state, conversationKey);
    const turn = Number(payload.turn);
    const runtimeMetadata = buildRuntimeMetadata(payload.source || null);
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
      ...runtimeMetadata,
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

    const previousRecord = conversation.turns[String(turn)] || null;
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
      binding: { conversationKey },
      scanMode: "manual_retry"
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
    markTurnSaved(conversation, turn, previousRecord, "manual_retry");

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
      decision: "reject_stale_binding"
    });
    return { ok: false, reason: "stale_node_binding" };
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
      captureEpoch: binding.navigationEpoch,
      decision: "reject_stale_binding"
    });
    return { ok: false, reason: "stale_node_binding" };
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
  const filePath = `qa/${stamp}__download_test.md`;
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

function buildEscapeSnapshotPath(conversation, turn, hash) {
  const date = new Date();
  const month = formatDatePart(date).slice(0, 7);
  const stamp = formatTimestampForPath(date);
  const folderPath = ensureConversationFolderPath(conversation, month, stamp);
  const turnPart = `turn_${String(Number(turn || 0)).padStart(4, "0")}`;
  return `${folderPath}/escape/${turnPart}__${safeToken(hash, 10)}__${stamp}__escape.md`;
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

function buildSavedMarkdown({ conversation, turn, status, rawHash, normalizedHash, filePath, snapshotText, binding, scanMode = null, variantMetadata = null }) {
  const variantFrontMatter = variantMetadata ? [
    `variantOfTurn: ${variantMetadata.variantOfTurn}`,
    `baseHash: ${yamlString(variantMetadata.baseHash || "")}`,
    `baseRawHash: ${yamlString(variantMetadata.baseRawHash || "")}`,
    `baseFilePath: ${yamlString(variantMetadata.baseFilePath || "")}`,
    `baseRecordType: ${yamlString(variantMetadata.baseRecordType || "")}`,
    `baseSaveState: ${yamlString(variantMetadata.baseSaveState || "")}`,
    `variantReason: ${yamlString(variantMetadata.variantReason || "normalized_hash_changed")}`,
    `scanCause: ${yamlString(variantMetadata.scanCause || "")}`
  ] : [];
  return [
    "---",
    `status: ${status}`,
    ...runtimeFrontMatter(scanMode),
    `conversationKey: ${yamlString(conversation.conversationKey)}`,
    `conversationUrl: ${yamlString(binding?.url || "")}`,
    `turn: ${turn}`,
    `detectedAt: ${yamlString(nowIso())}`,
    `rawHash: ${yamlString(rawHash)}`,
    `normalizedHash: ${yamlString(normalizedHash)}`,
    `filePath: ${yamlString(filePath)}`,
    ...variantFrontMatter,
    "---",
    "",
    `# turn ${turn} snapshot`,
    "",
    snapshotText.trim(),
    ""
  ].join("\n");
}

function buildVariantMetadata(existing, turn, scanCause) {
  return {
    variantOfTurn: Number(existing?.turn || turn),
    baseHash: existing?.normalizedHash || null,
    baseRawHash: existing?.rawHash || null,
    baseFilePath: existing?.filePath || null,
    baseRecordType: existing?.recordType || null,
    baseSaveState: existing?.saveState || null,
    variantReason: "normalized_hash_changed",
    scanCause: scanCause || null
  };
}

function buildMissingMarkdown({ conversation, turn, filePath, markerStatus, missingSections, reason, binding, scanMode = null }) {
  return [
    "---",
    "status: missing",
    ...runtimeFrontMatter(scanMode),
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

function buildEscapeMarkdown({ conversation, turn, rawHash, normalizedHash, filePath, assistantText, binding, markerStatus, turnSource, sourceTextLength, truncated, scanMode = null }) {
  return [
    "---",
    "status: escape",
    ...runtimeFrontMatter(scanMode),
    `conversationKey: ${yamlString(conversation.conversationKey)}`,
    `conversationUrl: ${yamlString(binding?.url || "")}`,
    `turn: ${Number(turn || 0)}`,
    `turnSource: ${yamlNullable(turnSource)}`,
    `detectedAt: ${yamlString(nowIso())}`,
    "reason: \"manual_escape\"",
    "privacyBoundary: \"manual_user_triggered_latest_assistant_only\"",
    `sourceTextLength: ${Number(sourceTextLength || assistantText.length || 0)}`,
    `truncated: ${Boolean(truncated)}`,
    `rawHash: ${yamlString(rawHash)}`,
    `normalizedHash: ${yamlString(normalizedHash)}`,
    `filePath: ${yamlString(filePath)}`,
    "markerStatus:",
    `  hasStart: ${Boolean(markerStatus?.hasStart)}`,
    `  hasEnd: ${Boolean(markerStatus?.hasEnd)}`,
    `  markerTurn: ${markerStatus?.markerTurn ?? "null"}`,
    "---",
    "",
    `# turn ${turn || "unknown"} escape checkpoint`,
    "",
    "Manual escape checkpoint. This is not a model-compliant Snapshot Keeper block.",
    "",
    assistantText.trim(),
    ""
  ].join("\n");
}

function runtimeFrontMatter(scanMode) {
  return [
    `appVersion: ${yamlString(APP_VERSION)}`,
    `gitCommit: ${yamlNullable(GIT_COMMIT)}`,
    `testMode: ${yamlNullable(TEST_MODE)}`,
    `scanMode: ${yamlNullable(scanMode)}`,
    `uiState: ${yamlNullable(UI_STATE)}`,
    `pathSchemaVersion: ${PATH_SCHEMA_VERSION}`,
    `writer: ${yamlString(FILE_WRITER)}`
  ];
}

function buildRuntimeMetadata(scanMode) {
  return {
    appVersion: APP_VERSION,
    gitCommit: GIT_COMMIT,
    testMode: TEST_MODE,
    scanMode: scanMode || null,
    uiState: UI_STATE,
    pathSchemaVersion: PATH_SCHEMA_VERSION,
    writer: FILE_WRITER
  };
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
  tab.visibleTurnSyncPending = false;
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
  const storedLastSeenTurn = Number(conversation.lastSeenTurn || 0);
  const visibleTurnSyncPending = Boolean(
    tabContext?.currentConversationKey === conversation.conversationKey &&
    tabContext.visibleTurnSyncPending &&
    !visibleTurn
  );
  const storageAheadOfVisible = Boolean(visibleTurn && storedLastSeenTurn && visibleTurn < storedLastSeenTurn);
  const displayTurn = visibleTurn || (visibleTurnSyncPending ? 0 : storedLastSeenTurn);
  const latestForDisplay = (storageAheadOfVisible || visibleTurnSyncPending) ? null : latest;

  return {
    conversationKey: conversation.conversationKey,
    displayTitle: conversation.displayTitle,
    lastSeenTurn: storedLastSeenTurn,
    visibleTurn,
    visibleTurnSource: tabContext?.visibleTurnSource || null,
    visibleTurnSeenAt: tabContext?.visibleTurnSeenAt || null,
    visibleTurnSyncPending,
    storageAheadOfVisible,
    displayTurn,
    nextSnapshotTurn: nextSnapshotTurn(displayTurn),
    storedNextSnapshotTurn: conversation.nextSnapshotTurn || nextSnapshotTurn(storedLastSeenTurn),
    savedCount: (conversation.savedTurns || []).length,
    missingCount: (conversation.missingTurns || []).length,
    variantCount: (conversation.variantTurns || []).length,
    escapeCount: (conversation.escapeRecords || []).filter((record) => record?.saveState === "save_confirmed").length,
    autoCaptureDisabled: Boolean(conversation.autoCaptureDisabled),
    autoCaptureDisabledReason: conversation.autoCaptureDisabledReason || null,
    latest: latestForDisplay,
    folderPath: conversation.folderPath || null
  };
}

function updateAutoCaptureGuard(state, conversation, sample) {
  if (!conversation || !sample) {
    return;
  }
  const now = Date.now();
  const recent = (conversation.autoGuardSamples || []).filter((entry) => now - Number(entry.t || 0) < AUTO_GUARD_WINDOW_MS);
  recent.push({
    t: now,
    type: sample.type || "unknown",
    source: sample.source || null,
    turn: Number(sample.turn || 0) || null,
    pathChanged: Boolean(sample.pathChanged),
    conversationChanged: Boolean(sample.conversationChanged),
    reason: sample.reason || null
  });
  conversation.autoGuardSamples = recent.slice(-80);
  if (conversation.autoCaptureDisabled) {
    return;
  }
  const pathChurn = recent.filter((entry) => entry.type === "context" && entry.pathChanged && !entry.conversationChanged).length;
  const staleCount = recent.filter((entry) => entry.type === "stale").length;
  const missingCount = recent.filter((entry) => entry.type === "missing" && entry.source === "latest").length;
  const turnCounts = {};
  for (const entry of recent) {
    if (entry.type === "turn_seen" && entry.source === "latest" && entry.turn) {
      turnCounts[String(entry.turn)] = Number(turnCounts[String(entry.turn)] || 0) + 1;
    }
  }
  const repeatedTurn = Object.entries(turnCounts).find(([, count]) => count >= AUTO_GUARD_REPEAT_TURN_LIMIT);
  let reason = null;
  if (pathChurn >= AUTO_GUARD_PATH_CHURN_LIMIT) {
    reason = repeatedTurn
      ? `path_churn_repeated_turn_${repeatedTurn[0]}`
      : "path_churn";
  } else if (staleCount >= AUTO_GUARD_STALE_LIMIT) {
    reason = "stale_binding_churn";
  } else if (missingCount >= AUTO_GUARD_MISSING_LIMIT) {
    reason = "repeated_live_missing";
  }
  if (!reason) {
    return;
  }
  conversation.autoCaptureDisabled = true;
  conversation.autoCaptureDisabledReason = reason;
  conversation.autoCaptureDisabledAt = nowIso();
  appendEvent(state, {
    type: "auto_capture_disabled_for_conversation",
    conversationKey: conversation.conversationKey,
    reason,
    pathChurn,
    staleCount,
    missingCount,
    repeatedTurn: repeatedTurn ? Number(repeatedTurn[0]) : null
  });
}

async function clearAutoCaptureGuard(tabId) {
  const state = await withState(async (draft) => {
    const context = getTabContextSnapshot(draft, tabId);
    const conversation = context?.currentConversationKey
      ? draft.conversations?.[context.currentConversationKey]
      : null;
    if (!conversation) {
      appendEvent(draft, {
        type: "auto_capture_guard_clear_skipped",
        tabId,
        reason: "conversation_not_found"
      });
      return draft;
    }
    const wasDisabled = Boolean(conversation.autoCaptureDisabled);
    delete conversation.autoCaptureDisabled;
    delete conversation.autoCaptureDisabledReason;
    delete conversation.autoCaptureDisabledAt;
    conversation.autoGuardSamples = [];
    appendEvent(draft, {
      type: "auto_capture_guard_cleared",
      tabId,
      conversationKey: conversation.conversationKey,
      wasDisabled
    });
    return draft;
  });
  const context = getTabContextSnapshot(state, tabId);
  return {
    context,
    status: getConversationStatus(state, context?.currentConversationKey, context)
  };
}

async function openArchiveFolder() {
  const folderUrl = toFileUrl(DEFAULT_ARCHIVE_FOLDER);
  try {
    await chrome.tabs.create({ url: folderUrl, active: true });
    return {
      opened: true,
      absolutePath: DEFAULT_ARCHIVE_FOLDER,
      folderUrl,
      openMode: "file_tab"
    };
  } catch (error) {
    return {
      opened: false,
      absolutePath: DEFAULT_ARCHIVE_FOLDER,
      folderUrl,
      error: String(error?.message || error)
    };
  }
}

function toFileUrl(absolutePath) {
  const normalized = String(absolutePath || "").replace(/\\/g, "/");
  return encodeURI(`file:///${normalized}`);
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

function yamlNullable(value) {
  return value === null || value === undefined || value === "" ? "null" : yamlString(value);
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
