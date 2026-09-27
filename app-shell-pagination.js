(function () {
  "use strict";

  const VERSION = "0.6.0";
  // Development diagnostics are disabled in release builds. Set DEBUG to true
  // locally when a live AppShell investigation needs an in-memory event log.
  const DEBUG = false;
  const TEST_MODE = globalThis.__CHATGPT_EDIT_PAGINATION_PATCH_TEST__ === true;
  const DIAGNOSTICS_ENABLED = DEBUG || TEST_MODE;
  const SHELL_ATTRIBUTE = "data-codex-window-type";
  const USER_BUBBLE = "[data-user-message-bubble]";
  const ASSISTANT_MESSAGE = "[data-chatgpt-selection-message-id]";
  const CONTROLS = "[data-batch-edit-pagination]";
  const ASSISTANT_CONTROLS = "[data-batch-assistant-pagination]";
  const NATIVE_VERSIONS_BUTTON = [
    'button[aria-label="See versions"]',
    'button[aria-label="Посмотреть версии"]',
    'button[aria-label="Просмотреть версии"]',
  ].join(", ");
  const BATCH_PATH = "/backend-api/conversations/batch";
  const RUNTIME_HINT = /^\/cdn\/assets\/633146\.[a-z0-9]+\.js$/;
  const MAX_GRAPHS = 3;
  const MAX_EVENTS = 500;
  const graphs = new Map();
  const scopeAdapters = new WeakMap();
  const pendingConversations = new Set();
  const conversationErrors = new Map();
  const observedBatchResponses = new WeakSet();
  const attemptedRuntimeUrls = new Set();
  const warned = new Set();
  const diagnostics = DIAGNOSTICS_ENABLED ? {
    version: VERSION,
    installedAt: new Date().toISOString(),
    batchResponses: 0,
    batchCaptures: 0,
    renders: 0,
    contextScans: 0,
    scopeScans: 0,
    scopeHydrations: 0,
    scopeHydrationFailures: 0,
    runtimeImports: 0,
    runtimeImportFailures: 0,
    switcherScans: 0,
    switcher: null,
    graphSummaries: 0,
    events: [],
  } : null;
  let runtime = null;
  let switcher = null;
  let runtimeDiscovery = null;
  let frame = null;
  let observer = null;
  let rootObserver = null;
  let stopped = false;
  let pass = 0;
  let graphRevision = 0;

  const record = (type, details = {}) => {
    if (!diagnostics) return;
    diagnostics.events.push({ at: new Date().toISOString(), type, ...details });
    if (diagnostics.events.length > MAX_EVENTS) diagnostics.events.splice(0, diagnostics.events.length - MAX_EVENTS);
  };

  const warnOnce = (key, message, details = {}) => {
    if (warned.has(key)) return;
    warned.add(key);
    const build = document.documentElement?.getAttribute("data-build") ?? "unknown";
    console.warn(`[Edit Pagination][batch] ${message} (build ${build})`, details);
    record("warning", { key, message, build, ...details });
  };

  const isShell = () => document.documentElement?.hasAttribute(SHELL_ATTRIBUTE) === true;

  const responseUrl = (response) => {
    try {
      return new URL(String(response?.url ?? ""), location.href);
    } catch {
      return null;
    }
  };

  const batchResponseUrl = (response) => {
    const url = responseUrl(response);
    return url?.origin === location.origin && url.pathname === BATCH_PATH ? url.href : null;
  };

  const isBatchResponse = (response) => batchResponseUrl(response) !== null;

  const cloneNode = (node) => ({
    ...node,
    children: Array.isArray(node?.children)
      ? node.children.filter((childId) => typeof childId === "string")
      : [],
  });

  const cloneMapping = (mapping) => Object.fromEntries(
    Object.entries(mapping ?? {})
      .filter(([, node]) => node && typeof node === "object")
      .map(([id, node]) => [id, cloneNode(node)]),
  );

  const compactMapping = (source) => {
    const compact = {};
    for (const [id, node] of Object.entries(source ?? {})) {
      if (!node || typeof node !== "object") continue;
      const role = typeof node.message?.author?.role === "string" ? node.message.author.role : null;
      const contentType = typeof node.message?.content?.content_type === "string"
        ? node.message.content.content_type
        : null;
      const parts = Array.isArray(node.message?.content?.parts) ? node.message.content.parts : [];
      const hidden = node.message?.metadata?.is_visually_hidden_from_conversation === true;
      const recipient = typeof node.message?.recipient === "string" ? node.message.recipient : null;
      const channel = typeof node.message?.channel === "string" ? node.message.channel : null;
      compact[id] = {
        parent: typeof node.parent === "string" ? node.parent : null,
        children: Array.isArray(node.children)
          ? node.children.filter((childId) => typeof childId === "string")
          : [],
        role,
        createTime: Number.isFinite(node.message?.create_time) ? node.message.create_time : null,
        visibleRole: !hidden && role === "user"
          ? "user"
          : !hidden && role === "assistant" &&
            (recipient === null || recipient === "all") &&
            (channel === null || channel === "final") &&
            (contentType === null || contentType === "text" || contentType === "multimodal_text") &&
            parts.some((part) =>
            typeof part === "string" ? part.length > 0 : part != null)
            ? "assistant"
            : null,
      };
    }
    return compact;
  };

  const userVariantAnchor = (graph, messageId) => {
    const node = graph?.mapping?.[messageId];
    if (node?.role !== "user" || !node.parent) return null;
    let cursor = node.parent;
    let highestTransparent = cursor;
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const candidate = graph.mapping[cursor];
      if (!candidate) break;
      if (candidate.visibleRole) return cursor;
      highestTransparent = cursor;
      cursor = candidate.parent;
    }
    return highestTransparent;
  };

  const userVariants = (graph, messageId) => {
    const anchor = userVariantAnchor(graph, messageId);
    if (!anchor) return [];
    const result = [];
    const queue = [...(graph.mapping[anchor]?.children ?? [])];
    const visited = new Set([anchor]);
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = graph.mapping[id];
      if (!node) continue;
      if (node.visibleRole) {
        if (node.visibleRole === "user") result.push(id);
        continue;
      }
      queue.push(...node.children);
    }
    if (!result.includes(messageId)) return [];
    return result.sort((left, right) => {
      const leftTime = graph.mapping[left]?.createTime;
      const rightTime = graph.mapping[right]?.createTime;
      if (leftTime === null && rightTime === null) return 0;
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return leftTime - rightTime;
    });
  };

  const assistantVariants = (graph, messageId) => {
    const node = graph?.mapping?.[messageId];
    if (node?.visibleRole !== "assistant" || !node.parent) return [];
    let anchor = node.parent;
    const parents = new Set([messageId]);
    while (anchor && !parents.has(anchor)) {
      parents.add(anchor);
      const candidate = graph.mapping[anchor];
      if (!candidate) return [];
      if (candidate.visibleRole === "user") break;
      if (candidate.visibleRole === "assistant") return [];
      anchor = candidate.parent;
    }
    if (graph.mapping[anchor]?.visibleRole !== "user") return [];
    const result = [];
    const queue = [...(graph.mapping[anchor]?.children ?? [])];
    const visited = new Set([anchor]);
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const candidate = graph.mapping[id];
      if (!candidate) continue;
      if (candidate.visibleRole) {
        if (candidate.visibleRole === "assistant") result.push(id);
        continue;
      }
      queue.push(...candidate.children);
    }
    if (!result.includes(messageId)) return [];
    return result.sort((left, right) => {
      const leftTime = graph.mapping[left]?.createTime;
      const rightTime = graph.mapping[right]?.createTime;
      if (leftTime === null && rightTime === null) return 0;
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return leftTime - rightTime;
    });
  };

  const mergeMappings = (batchMapping, liveMapping) => {
    const merged = cloneMapping(batchMapping);
    for (const [id, liveNode] of Object.entries(liveMapping ?? {})) {
      if (!liveNode || typeof liveNode !== "object") continue;
      const batchNode = merged[id];
      if (!batchNode) {
        merged[id] = cloneNode(liveNode);
        continue;
      }
      merged[id] = {
        ...batchNode,
        ...liveNode,
        // The paginated shell rewrites the first retained node to a synthetic
        // root. The batch graph remains authoritative for nodes it already has.
        parent: batchNode.parent,
        children: [...new Set([...(batchNode.children ?? []), ...(liveNode.children ?? [])])],
      };
    }
    // The paginated shell adds shortcut child edges when it rebases a retained
    // slice onto its synthetic root. Those edges are not real graph branches
    // and make the native assistant pager count duplicate responses. Keep only
    // edges that agree with the child's authoritative parent, then rebuild any
    // missing parent-to-child links below.
    for (const [id, node] of Object.entries(merged)) {
      node.children = [...new Set(node.children ?? [])]
        .filter((childId) => merged[childId]?.parent === id);
    }
    for (const [id, node] of Object.entries(merged)) {
      if (!node.parent || !merged[node.parent]) continue;
      const parent = merged[node.parent];
      if (!parent.children.includes(id)) parent.children = [...parent.children, id];
    }
    return merged;
  };

  const createGraphState = (payload) => {
    if (!payload || typeof payload !== "object" || !payload.mapping || typeof payload.mapping !== "object") {
      return null;
    }
    const conversationId = String(payload.conversation_id ?? payload.id ?? "");
    if (!conversationId) return null;
    const batchMapping = cloneMapping(payload.mapping);
    return {
      conversationId,
      currentNode: typeof payload.current_node === "string" ? payload.current_node : null,
      batchMapping,
      liveMapping: batchMapping,
      mapping: compactMapping(batchMapping),
      revision: ++graphRevision,
    };
  };

  const graphSummary = (graph) => {
    if (diagnostics) diagnostics.graphSummaries++;
    const userGroups = new Set();
    const assistantGroups = new Set();
    let maxUserVariants = 0;
    for (const [id, node] of Object.entries(graph.mapping)) {
      if (!Array.isArray(node.children)) continue;
      if (node.role === "user") {
        const ids = userVariants(graph, id);
        if (ids.length > 1) {
          userGroups.add(ids.join("\0"));
          maxUserVariants = Math.max(maxUserVariants, ids.length);
        }
      }
      if (node.visibleRole === "assistant") {
        const ids = assistantVariants(graph, id);
        if (ids.length > 1) assistantGroups.add(ids.join("\0"));
      }
    }
    return {
      conversationId: graph.conversationId,
      currentNode: graph.currentNode,
      mappingCount: Object.keys(graph.mapping).length,
      userVariantGroups: userGroups.size,
      assistantVariantGroups: assistantGroups.size,
      maxUserVariants,
    };
  };

  const storeGraph = (graph) => {
    graphs.delete(graph.conversationId);
    graphs.set(graph.conversationId, graph);
    const protectedIds = new Set();
    const pathMatch = location.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
    if (pathMatch) protectedIds.add(pathMatch[1]);
    for (const controls of document.querySelectorAll(CONTROLS)) {
      if (controls.dataset.conversationId) protectedIds.add(controls.dataset.conversationId);
    }
    while (graphs.size > MAX_GRAPHS) {
      const victim = [...graphs.keys()].find((conversationId) => !protectedIds.has(conversationId));
      if (!victim) break;
      graphs.delete(victim);
    }
  };

  const captureBatch = (payload, url) => {
    const conversations = Array.isArray(payload) ? payload : [];
    const captured = diagnostics ? [] : null;
    let capturedCount = 0;
    for (const conversation of conversations) {
      const graph = createGraphState(conversation);
      if (!graph) continue;
      storeGraph(graph);
      capturedCount++;
      captured?.push({ conversationId: graph.conversationId, currentNode: graph.currentNode });
    }
    if (diagnostics) {
      diagnostics.batchCaptures++;
      record("batch-captured", { url, conversationCount: conversations.length, graphs: captured });
    }
    if (!capturedCount) warnOnce("batch-shape", "The batch response did not contain a usable conversation graph.");
    schedule();
    return capturedCount;
  };

  const observeBatchPayload = (responseKey, payload, source, url) => {
    if (observedBatchResponses.has(responseKey)) return;
    observedBatchResponses.add(responseKey);
    if (diagnostics) {
      diagnostics.batchResponses++;
      record("batch-response", { url, source });
    }
    captureBatch(payload, url);
  };

  const observeBatchError = (url, error) => {
    warnOnce("batch-json", "The batch response could not be parsed.", {
      error: String(error),
      url,
    });
  };

  const installBatchObserver = () => {
    if (typeof Response === "undefined") return;
    if (typeof Response.prototype.json === "function") {
      const originalResponseJson = Response.prototype.json;
      Response.prototype.json = function observedBatchResponseJson(...args) {
        const url = batchResponseUrl(this);
        const parsedPromise = Reflect.apply(originalResponseJson, this, args);
        if (url === null) return parsedPromise;
        return parsedPromise.then(
          (payload) => {
            observeBatchPayload(this, payload, "json", url);
            return payload;
          },
          (error) => {
            observeBatchError(url, error);
            throw error;
          },
        );
      };
    }
    if (typeof Response.prototype.text === "function") {
      const originalResponseText = Response.prototype.text;
      Response.prototype.text = function observedBatchResponseText(...args) {
        const url = batchResponseUrl(this);
        const textPromise = Reflect.apply(originalResponseText, this, args);
        if (url === null) return textPromise;
        return textPromise.then(
          (text) => {
            try {
              observeBatchPayload(this, JSON.parse(text), "text", url);
            } catch (error) {
              observeBatchError(url, error);
            }
            return text;
          },
          (error) => {
            observeBatchError(url, error);
            throw error;
          },
        );
      };
    }
  };

  const getFiber = (element) => Object.getOwnPropertyNames(element)
    .find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));

  const currentFiber = (fiber) => {
    const alternate = fiber?.alternate;
    if (!alternate) return fiber;
    let left = fiber;
    let right = alternate;
    for (let depth = 0; left && right && depth < 100; depth++) {
      const leftParent = left.return;
      const rightParent = right.return;
      if (!leftParent || !rightParent) break;
      if (leftParent === rightParent || leftParent.child === rightParent.child) {
        for (let child = leftParent.child; child; child = child.sibling) {
          if (child === left) return fiber;
          if (child === right) return alternate;
        }
      }
      if (leftParent !== rightParent &&
          leftParent.alternate !== rightParent && rightParent.alternate !== leftParent) break;
      left = leftParent;
      right = rightParent;
    }
    const rootOf = (candidate) => {
      let root = candidate;
      for (let depth = 0; root?.return && depth < 200; depth++) root = root.return;
      return root;
    };
    const leftRoot = rootOf(fiber);
    const rightRoot = rootOf(alternate);
    const activeRoot = leftRoot?.stateNode?.current ?? rightRoot?.stateNode?.current;
    if (leftRoot !== rightRoot && activeRoot === rightRoot) return alternate;
    return fiber;
  };

  const isScope = (value) => value && typeof value === "object" &&
    value.scope?.__scopeBrand === "AppScope" && typeof value.get === "function";

  const scopeInHooks = (hook) => {
    for (let index = 0; hook && index < 150; index++, hook = hook.next) {
      if (isScope(hook.memoizedState)) return hook.memoizedState;
      if (isScope(hook.memoizedState?.current)) return hook.memoizedState.current;
    }
    return null;
  };

  const readContext = (bubble) => {
    if (diagnostics) diagnostics.contextScans++;
    const key = getFiber(bubble);
    let fiber = currentFiber(key ? bubble[key] : null);
    let scope = null;
    let context = null;
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
      scope ??= scopeInHooks(fiber.memoizedState);
      const props = fiber.memoizedProps;
      if (!context && props && typeof props === "object" &&
          props.item?.type === "user-message" && typeof props.item.messageId === "string" &&
          typeof props.conversationId === "string") {
        context = { conversationId: props.conversationId, messageId: props.item.messageId };
      }
    }
    return scope && context ? { ...context, scope } : null;
  };

  const mappingScore = (value, graph, messageId) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return -1;
    if (!value[messageId] && !(graph?.currentNode && value[graph.currentNode])) return -1;
    const nodes = Object.values(value);
    if (!nodes.some((node) => node && typeof node === "object" &&
        Array.isArray(node.children) && "parent" in node && "message" in node)) return -1;
    let knownNodes = 0;
    for (const id of Object.keys(graph?.mapping ?? {})) if (value[id]) knownNodes++;
    return knownNodes * 100 + Math.min(nodes.length, 99);
  };

  const adapterCacheFor = (scope) => {
    const owner = scope.node ?? scope;
    let cache = scopeAdapters.get(owner);
    if (!cache) {
      cache = new Map();
      scopeAdapters.set(owner, cache);
    }
    return cache;
  };

  const discoverScopeAdapter = (context, graph) => {
    const cache = adapterCacheFor(context.scope);
    const cached = cache.get(context.conversationId);
    if (cached) {
      try {
        context.scope.get(cached.mappingSignal, context.conversationId);
        return cached;
      } catch {
        cache.delete(context.conversationId);
      }
    }
    if (diagnostics) diagnostics.scopeScans++;
    let best = null;
    const families = context.scope.node?.familyBindings;
    if (!families || typeof families.keys !== "function") return null;
    for (const atom of families.keys()) {
      if (atom?.kind !== "signal-family") continue;
      let value;
      try {
        value = context.scope.get(atom, context.conversationId);
      } catch {
        continue;
      }
      const score = mappingScore(value, graph, context.messageId);
      if (score < 0 || (best && best.score >= score)) continue;
      best = { mappingSignal: atom, score };
    }
    if (!best) return null;
    const adapter = { mappingSignal: best.mappingSignal, lastApplied: null, lastRevision: 0 };
    cache.set(context.conversationId, adapter);
    if (diagnostics) {
      record("scope-adapter-found", {
        conversationId: context.conversationId,
        mappingScore: best.score,
      });
    }
    return adapter;
  };

  const restoreGraphFromScope = (context) => {
    const adapter = discoverScopeAdapter(context, null);
    if (!adapter) return null;
    let liveMapping;
    try {
      liveMapping = context.scope.get(adapter.mappingSignal, context.conversationId);
    } catch {
      return null;
    }
    const graph = createGraphState({
      id: context.conversationId,
      current_node: context.messageId,
      mapping: liveMapping,
    });
    if (!graph) return null;
    storeGraph(graph);
    adapter.lastApplied = liveMapping;
    adapter.lastRevision = graph.revision;
    if (diagnostics) {
      record("graph-restored-from-scope", {
        conversationId: context.conversationId,
        mappingCount: Object.keys(graph.mapping).length,
      });
    }
    return graph;
  };

  const graphFor = (context) => {
    const graph = graphs.get(context.conversationId) ??
      [...graphs.values()].find((candidate) => candidate.mapping[context.messageId]);
    if (!graph) return restoreGraphFromScope(context);
    graphs.delete(graph.conversationId);
    graphs.set(graph.conversationId, graph);
    return graph;
  };

  const hydrateGraph = (context, graph) => {
    const adapter = discoverScopeAdapter(context, graph);
    if (!adapter) return false;
    let liveMapping;
    try {
      liveMapping = context.scope.get(adapter.mappingSignal, context.conversationId);
    } catch (error) {
      if (diagnostics) {
        diagnostics.scopeHydrationFailures++;
        record("scope-hydration-failed", { conversationId: context.conversationId, error: String(error) });
      }
      return false;
    }
    if (liveMapping === adapter.lastApplied && adapter.lastRevision === graph.revision) return true;
    const merged = mergeMappings(graph.liveMapping ?? graph.batchMapping, liveMapping);
    graph.liveMapping = merged;
    graph.mapping = compactMapping(merged);
    try {
      context.scope.set(adapter.mappingSignal, context.conversationId, merged);
      adapter.lastApplied = merged;
      adapter.lastRevision = graph.revision;
      if (diagnostics) {
        diagnostics.scopeHydrations++;
        record("scope-hydrated", {
          conversationId: context.conversationId,
          batchMappingCount: Object.keys(graph.batchMapping).length,
          liveMappingCount: Object.keys(liveMapping ?? {}).length,
          mergedMappingCount: Object.keys(merged).length,
        });
      }
      return true;
    } catch (error) {
      if (diagnostics) {
        diagnostics.scopeHydrationFailures++;
        record("scope-hydration-failed", { conversationId: context.conversationId, error: String(error) });
      }
      return false;
    }
  };

  const findMount = (bubble) => {
    let element = bubble.parentElement;
    for (let depth = 0; element && depth < 9; depth++, element = element.parentElement) {
      if (element.querySelectorAll(USER_BUBBLE).length !== 1) continue;
      const rows = element.querySelectorAll(".turn-action-controls");
      if (rows.length === 1) return { mount: rows[0].parentElement, row: rows[0] };
    }
    return null;
  };

  const labels = () => document.documentElement.lang.toLowerCase().startsWith("ru")
    ? {
      previous: "Предыдущая версия",
      next: "Следующая версия",
      group: "Версии сообщения",
      version: (number) => `Перейти к версии ${number}`,
      failed: "Не удалось переключить версию сообщения.",
    }
    : {
      previous: "Previous version",
      next: "Next version",
      group: "Message versions",
      version: (number) => `Go to version ${number}`,
      failed: "Could not switch the message version.",
    };

  const assistantLabels = () => document.documentElement.lang.toLowerCase().startsWith("ru")
    ? {
      previous: "Предыдущий ответ",
      next: "Следующий ответ",
      group: "Версии ответа",
      failed: "Не удалось переключить версию ответа.",
    }
    : {
      previous: "Previous response",
      next: "Next response",
      group: "Response versions",
      failed: "Could not switch the response version.",
    };

  const createButton = (label, direction, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", direction < 0 ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    button.append(svg);
    button.addEventListener("click", action);
    return button;
  };

  const requestSwitch = async (context, currentMessageId, targetMessageId, failureMessage) => {
    if (!switcher) {
      await discoverRuntime();
      scanSwitcher();
    }
    if (!switcher) {
      warnOnce("switcher-missing", "The native branch switcher is not available.");
      return;
    }
    pendingConversations.add(context.conversationId);
    conversationErrors.delete(context.conversationId);
    if (diagnostics) {
      record("switch-requested", {
        conversationId: context.conversationId,
        currentMessageId,
        targetMessageId,
      });
    }
    schedule();
    try {
      await switcher(context.scope, context.conversationId, targetMessageId);
      if (diagnostics) record("switch-completed", { conversationId: context.conversationId, targetMessageId });
    } catch (error) {
      conversationErrors.set(context.conversationId, failureMessage);
      if (diagnostics) record("switch-failed", { conversationId: context.conversationId, targetMessageId, error: String(error) });
      warnOnce("switch-failed", failureMessage, { error: String(error) });
    } finally {
      pendingConversations.delete(context.conversationId);
      schedule();
    }
  };

  const switchVersion = async (bubble, { direction = 0, targetMessageId = null } = {}) => {
    const context = readContext(bubble);
    if (!context || pendingConversations.has(context.conversationId)) return;
    const graph = graphFor(context);
    if (!graph || !hydrateGraph(context, graph)) return;
    const ids = userVariants(graph, context.messageId);
    const index = ids.indexOf(context.messageId);
    const target = index < 0 ? null : targetMessageId ?? ids[index + direction];
    // Revalidate against the current graph, not a possibly stale button index.
    if (!target || target === context.messageId || !ids.includes(target)) return;
    await requestSwitch(context, context.messageId, target, labels().failed);
  };

  const paintUserPagination = (bubble, context, graph, mountInfo, currentPass) => {
    const ids = userVariants(graph, context.messageId);
    const index = ids.indexOf(context.messageId);
    const { mount } = mountInfo;
    let controls = mount.querySelector(CONTROLS);
    if (ids.length < 2 || index < 0) {
      controls?.remove();
      return false;
    }
    if (!controls) {
      const text = labels();
      controls = document.createElement("span");
      controls.setAttribute("data-batch-edit-pagination", "");
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", text.group);
      const previous = createButton(text.previous, -1, (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchVersion(controls.paginationBubble, { direction: -1 });
      });
      const counter = document.createElement("span");
      counter.setAttribute("aria-live", "polite");
      counter.setAttribute("aria-atomic", "true");
      counter.setAttribute("data-batch-version-status", "");
      const numbers = document.createElement("span");
      numbers.setAttribute("data-batch-version-numbers", "");
      const next = createButton(text.next, 1, (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchVersion(controls.paginationBubble, { direction: 1 });
      });
      controls.append(previous, counter, numbers, next);
    }
    // React can reuse the action row while replacing the message bubble.
    controls.paginationBubble = bubble;
    controls.dataset.pass = String(currentPass);
    controls.dataset.conversationId = context.conversationId;
    controls.dataset.messageId = context.messageId;
    if (controls.parentElement !== mount) mount.append(controls);
    const [previous, counter, numbers, next] = controls.children;
    const caption = `${index + 1}/${ids.length}`;
    if (counter.textContent !== caption) counter.textContent = caption;
    const busy = pendingConversations.has(context.conversationId);
    previous.disabled = busy || index === 0;
    next.disabled = busy || index === ids.length - 1;
    controls.setAttribute("aria-busy", String(busy));
    const error = conversationErrors.get(context.conversationId) ?? "";
    controls.title = error;
    counter.setAttribute("aria-label", error ? `${caption}. ${error}` : caption);
    while (numbers.children.length > ids.length) numbers.lastElementChild.remove();
    while (numbers.children.length < ids.length) {
      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchVersion(controls.paginationBubble, { targetMessageId: button.dataset.versionId });
      });
      numbers.append(button);
    }
    const text = labels();
    for (const [number, button] of [...numbers.children].entries()) {
      const caption = String(number + 1);
      if (button.textContent !== caption) button.textContent = caption;
      button.dataset.versionId = ids[number];
      button.setAttribute("aria-label", text.version(number + 1));
      button.title = text.version(number + 1);
      button.disabled = busy;
      if (number === index) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    // Keep the selected number visible without moving the conversation viewport
    // or undoing a user's horizontal scroll on every reconciliation pass.
    if (numbers.dataset.selectedMessageId !== context.messageId) {
      numbers.dataset.selectedMessageId = context.messageId;
      const selected = numbers.children[index];
      if (selected.offsetLeft < numbers.scrollLeft) numbers.scrollLeft = selected.offsetLeft;
      else if (selected.offsetLeft + selected.offsetWidth > numbers.scrollLeft + numbers.clientWidth) {
        numbers.scrollLeft = selected.offsetLeft + selected.offsetWidth - numbers.clientWidth;
      }
    }
    return true;
  };

  const suppressNativeVersions = (root, details = {}) => {
    for (const button of root.querySelectorAll(NATIVE_VERSIONS_BUTTON)) {
      if (!button.hasAttribute("data-batch-pagination-suppressed")) {
        button.setAttribute("data-batch-pagination-suppressed", "");
        if (diagnostics) record("native-versions-suppressed", details);
      }
    }
  };

  const assistantActionRowFor = (message) => {
    let element = message.parentElement;
    for (let depth = 0; element && depth < 10; depth++, element = element.parentElement) {
      if (element.querySelectorAll(ASSISTANT_MESSAGE).length !== 1) continue;
      for (const row of element.querySelectorAll(".turn-action-controls")) {
        if (row.querySelector(
          'button[aria-label="Regenerate response"], button[aria-label="Сгенерировать ответ заново"]',
        )) return row;
      }
    }
    return null;
  };

  const nativeAssistantPaginationFor = (row) => {
    if (!row) return null;
    const previousButtons = row.querySelectorAll(
      'button[aria-label="Previous response"], button[aria-label="Предыдущий ответ"]',
    );
    const nextButtons = [...row.querySelectorAll(
      'button[aria-label="Next response"], button[aria-label="Следующий ответ"]',
    )];
    for (const previous of previousButtons) {
      const wrapper = previous.parentElement;
      if (!wrapper || wrapper.matches(ASSISTANT_CONTROLS)) continue;
      const next = nextButtons.find((candidate) => candidate.parentElement === wrapper);
      if (next && /^\s*\d+\s*\/\s*\d+\s*$/.test(wrapper.textContent ?? "")) return wrapper;
    }
    return null;
  };

  const assistantPaginationMount = (row) => {
    const more = row.querySelector('button[aria-label="More actions"], button[aria-label="Ещё действия"]');
    if (!more) return { mount: row, insertionPoint: null };
    let rowChild = more;
    while (rowChild.parentElement && rowChild.parentElement !== row) rowChild = rowChild.parentElement;
    if (rowChild.parentElement !== row) return { mount: row, insertionPoint: null };
    if (rowChild === more) return { mount: row, insertionPoint: more };
    const mount = rowChild;
    let insertionPoint = more;
    while (insertionPoint.parentElement && insertionPoint.parentElement !== mount) {
      insertionPoint = insertionPoint.parentElement;
    }
    return {
      mount,
      insertionPoint: insertionPoint.parentElement === mount ? insertionPoint : null,
    };
  };

  const contextForConversation = (conversationId) => {
    for (const bubble of document.querySelectorAll(USER_BUBBLE)) {
      const context = readContext(bubble);
      if (context?.conversationId === conversationId) return context;
    }
    return null;
  };

  const switchAssistantVersion = async (messageId, direction) => {
    const graph = [...graphs.values()].find((candidate) => candidate.mapping[messageId]);
    if (!graph) return;
    const context = contextForConversation(graph.conversationId);
    if (!context || pendingConversations.has(context.conversationId) || !hydrateGraph(context, graph)) return;
    const ids = assistantVariants(graph, messageId);
    const index = ids.indexOf(messageId);
    const target = index < 0 ? null : ids[index + direction];
    if (!target) return;
    await requestSwitch(context, messageId, target, assistantLabels().failed);
  };

  const paintAssistantPagination = (message, context, graph, row, currentPass) => {
    const messageId = message.getAttribute("data-chatgpt-selection-message-id");
    if (!messageId) return false;
    suppressNativeVersions(row, { role: "assistant", messageId });
    const ids = assistantVariants(graph, messageId);
    const index = ids.indexOf(messageId);
    const native = nativeAssistantPaginationFor(row);
    let controls = row.querySelector(ASSISTANT_CONTROLS);
    if (native) {
      const phantom = ids.length < 2;
      if (phantom && !native.hasAttribute("data-batch-pagination-suppressed")) {
        native.setAttribute("data-batch-pagination-suppressed", "");
        if (diagnostics) record("phantom-assistant-pagination-suppressed", { messageId });
      } else if (!phantom && native.hasAttribute("data-batch-pagination-suppressed")) {
        native.removeAttribute("data-batch-pagination-suppressed");
        if (diagnostics) record("assistant-pagination-restored", { messageId });
      }
      controls?.remove();
      return false;
    }
    if (ids.length < 2 || index < 0 || !context) {
      controls?.remove();
      return false;
    }
    if (!controls) {
      const text = assistantLabels();
      controls = document.createElement("span");
      controls.setAttribute("data-batch-edit-pagination", "");
      controls.setAttribute("data-batch-assistant-pagination", "");
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", text.group);
      const previous = createButton(text.previous, -1, (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchAssistantVersion(controls.dataset.messageId, -1);
      });
      const counter = document.createElement("span");
      counter.setAttribute("aria-live", "polite");
      counter.setAttribute("aria-atomic", "true");
      const next = createButton(text.next, 1, (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchAssistantVersion(controls.dataset.messageId, 1);
      });
      controls.append(previous, counter, next);
    }
    controls.dataset.pass = String(currentPass);
    controls.dataset.conversationId = context.conversationId;
    controls.dataset.messageId = messageId;
    const { mount, insertionPoint } = assistantPaginationMount(row);
    if (controls.parentElement !== mount || (insertionPoint && controls.nextElementSibling !== insertionPoint)) {
      mount.insertBefore(controls, insertionPoint);
    }
    const [previous, counter, next] = controls.children;
    const caption = `${index + 1}/${ids.length}`;
    if (counter.textContent !== caption) counter.textContent = caption;
    const busy = pendingConversations.has(context.conversationId);
    previous.disabled = busy || index === 0;
    next.disabled = busy || index === ids.length - 1;
    controls.setAttribute("aria-busy", String(busy));
    const error = conversationErrors.get(context.conversationId) ?? "";
    controls.title = error;
    counter.setAttribute("aria-label", error ? `${caption}. ${error}` : caption);
    return true;
  };

  const reconcileAssistantPagination = (currentPass, contexts) => {
    let painted = 0;
    for (const message of document.querySelectorAll(ASSISTANT_MESSAGE)) {
      const messageId = message.getAttribute("data-chatgpt-selection-message-id");
      if (!messageId) continue;
      const graph = [...graphs.values()].find((candidate) => candidate.mapping[messageId]);
      if (!graph) continue;
      const context = contexts.get(graph.conversationId) ?? null;
      if (context && !hydrateGraph(context, graph)) continue;
      const row = assistantActionRowFor(message);
      if (!row) continue;
      if (paintAssistantPagination(message, context, graph, row, currentPass)) painted++;
    }
    return painted;
  };

  const candidateSource = (value) => {
    try {
      return Function.prototype.toString.call(value);
    } catch {
      return "";
    }
  };

  const scanSwitcher = () => {
    if (switcher || !runtime?.c) return switcher;
    if (diagnostics) diagnostics.switcherScans++;
    const hits = [];
    for (const [moduleId, module] of Object.entries(runtime.c)) {
      const exports = module?.exports;
      if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;
      let keys;
      try {
        keys = Object.keys(exports);
      } catch {
        continue;
      }
      for (const exportName of keys) {
        let candidate;
        try {
          candidate = exports[exportName];
        } catch {
          continue;
        }
        if (typeof candidate !== "function") continue;
        const source = candidateSource(candidate);
        if (source.includes("current_node_id") && source.includes("/conversation/{conversation_id}")) {
          hits.push({ moduleId, exportName, candidate });
        }
      }
    }
    if (hits.length === 1) {
      switcher = hits[0].candidate;
      const switcherDetails = { moduleId: hits[0].moduleId, exportName: hits[0].exportName };
      if (diagnostics) {
        diagnostics.switcher = switcherDetails;
        record("switcher-found", switcherDetails);
      }
      schedule();
    } else if (hits.length > 1) {
      warnOnce("switcher-ambiguous", "More than one native branch switcher matched the required behavior.", {
        candidates: hits.map(({ moduleId, exportName }) => ({ moduleId, exportName })),
      });
    }
    return switcher;
  };

  const attachRuntime = (candidate) => {
    if (runtime || !candidate?.c || !candidate?.m) return false;
    runtime = candidate;
    if (diagnostics) record("runtime-found", { cacheSize: Object.keys(runtime.c).length });
    scanSwitcher();
    return true;
  };

  const runtimeUrls = () => {
    const paths = [];
    const manifest = globalThis.__reactRouterManifest;
    if (Array.isArray(manifest?.entry?.imports)) paths.push(...manifest.entry.imports);
    if (typeof manifest?.entry?.module === "string") paths.push(manifest.entry.module);
    for (const link of document.querySelectorAll('link[rel="modulepreload"][href]')) paths.push(link.href);
    for (const script of document.scripts) {
      for (const match of script.textContent?.matchAll?.(/\bimport\(["']([^"']+\.js)["']\)/g) ?? []) {
        paths.push(match[1]);
      }
    }
    const urls = [];
    for (const path of paths) {
      try {
        const url = new URL(path, location.href);
        if (url.origin === location.origin && url.pathname.endsWith(".js")) urls.push(url);
      } catch {
        // A malformed manifest entry is simply not a runtime candidate.
      }
    }
    const unique = [...new Map(urls.map((url) => [url.href, url])).values()];
    unique.sort((a, b) => Number(RUNTIME_HINT.test(b.pathname)) - Number(RUNTIME_HINT.test(a.pathname)));
    return unique;
  };

  async function discoverRuntime() {
    if (runtime || stopped) return runtime;
    if (runtimeDiscovery) return runtimeDiscovery;
    runtimeDiscovery = (async () => {
      const urls = runtimeUrls();
      if (diagnostics) record("runtime-candidates", { count: urls.length, urls: urls.map((url) => url.pathname) });
      for (const url of urls) {
        if (attemptedRuntimeUrls.has(url.href)) continue;
        attemptedRuntimeUrls.add(url.href);
        if (diagnostics) diagnostics.runtimeImports++;
        try {
          const module = await import(url.href);
          if (attachRuntime(module.__webpack_require__)) {
            if (diagnostics) record("runtime-imported", { url: url.pathname });
            break;
          }
        } catch (error) {
          if (diagnostics) {
            diagnostics.runtimeImportFailures++;
            record("runtime-import-failed", { url: url.href, error: String(error) });
          }
        }
      }
      return runtime;
    })().finally(() => {
      runtimeDiscovery = null;
    });
    return runtimeDiscovery;
  }

  const reconcile = () => {
    frame = null;
    if (stopped) return;
    if (diagnostics) diagnostics.renders++;
    const currentPass = ++pass;
    if (!isShell()) {
      for (const controls of document.querySelectorAll(CONTROLS)) controls.remove();
      return;
    }
    const bubbles = [...document.querySelectorAll(USER_BUBBLE)];
    const contexts = new Map();
    let painted = 0;
    for (const bubble of bubbles) {
      const mountInfo = findMount(bubble);
      if (!mountInfo) continue;
      suppressNativeVersions(mountInfo.row, { role: "user" });
      const context = readContext(bubble);
      if (!context) continue;
      contexts.set(context.conversationId, context);
      const graph = graphFor(context);
      if (!graph) continue;
      if (!hydrateGraph(context, graph)) continue;
      if (paintUserPagination(bubble, context, graph, mountInfo, currentPass)) painted++;
    }
    const assistantPainted = reconcileAssistantPagination(currentPass, contexts);
    for (const controls of document.querySelectorAll(CONTROLS)) {
      if (controls.dataset.pass !== String(currentPass)) controls.remove();
    }
    if (diagnostics) record("render", { bubbleCount: bubbles.length, painted, assistantPainted, graphCount: graphs.size });
    if (bubbles.length && graphs.size && !runtime) void discoverRuntime();
    else if (runtime && !switcher) scanSwitcher();
  };

  function schedule() {
    if (stopped || frame !== null || typeof requestAnimationFrame !== "function") return;
    frame = requestAnimationFrame(reconcile);
  }

  const mutationMatters = (mutation) => {
    if (mutation.type === "attributes") return true;
    if (mutation.target?.nodeType === 1 && mutation.target.closest?.(".turn-action-controls")) return true;
    const relevant = (node) => node.nodeType === 1 &&
      (node.matches?.(USER_BUBBLE) || node.querySelector?.(USER_BUBBLE) ||
       node.matches?.(".turn-action-controls") || node.querySelector?.(".turn-action-controls") ||
       node.matches?.('link[rel="modulepreload"]'));
    return [...mutation.addedNodes, ...mutation.removedNodes].some(relevant);
  };

  const observe = () => {
    const root = document.documentElement;
    if (!root || observer) return;
    observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationMatters)) schedule();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [SHELL_ATTRIBUTE, "data-user-message-bubble"],
    });
    schedule();
  };

  const debugSnapshot = () => {
    if (!diagnostics) return null;
    const graphSnapshots = [...graphs.values()].map((graph) => ({
      conversationId: graph.conversationId,
      currentNode: graph.currentNode,
      revision: graph.revision,
      mapping: graph.mapping,
      summary: graphSummary(graph),
    }));
    return {
      version: VERSION,
      capturedAt: new Date().toISOString(),
      location: { origin: location.origin, pathname: location.pathname },
      document: {
        build: document.documentElement?.getAttribute("data-build") ?? null,
        shell: isShell(),
        lang: document.documentElement?.lang ?? "",
        readyState: document.readyState,
      },
      diagnostics: {
        ...diagnostics,
        events: diagnostics.events.slice(),
      },
      graphs: graphSnapshots,
      controls: [...document.querySelectorAll(CONTROLS)].map((controls) => ({
        conversationId: controls.dataset.conversationId ?? null,
        messageId: controls.dataset.messageId ?? null,
        caption: controls.textContent,
      })),
    };
  };

  const downloadDebugSnapshot = () => {
    const blob = new Blob([JSON.stringify(debugSnapshot(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `chatgpt-edit-pagination-batch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  installBatchObserver();
  if (document.documentElement) observe();
  else {
    rootObserver = new MutationObserver(() => {
      if (!document.documentElement) return;
      rootObserver.disconnect();
      rootObserver = null;
      observe();
    });
    rootObserver.observe(document, { childList: true });
  }
  addEventListener("pageshow", schedule);
  addEventListener("popstate", schedule);
  addEventListener("load", () => {
    schedule();
    if (isShell() && graphs.size && !runtime) void discoverRuntime().then((value) => {
      if (!value) warnOnce("runtime-missing", "The webpack runtime could not be discovered from loaded module preloads.");
    });
  }, { once: true });
  addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    observer?.disconnect();
    rootObserver?.disconnect();
  }, { once: true });

  if (DIAGNOSTICS_ENABLED) {
    globalThis.__chatgptBatchPagination = {
      version: VERSION,
      getDebugSnapshot: debugSnapshot,
      downloadDebugSnapshot,
    };
  }

  if (TEST_MODE) {
    globalThis.__chatgptBatchPaginationTest = {
      attachRuntime,
      assistantVariants,
      captureBatch,
      createGraphState,
      currentFiber,
      graphFor,
      graphSummary,
      getGraphSummaryRuns: () => diagnostics.graphSummaries,
      hydrateGraph,
      isBatchResponse,
      mergeMappings,
      mutationMatters,
      paintAssistantPagination,
      paintUserPagination,
      readContext,
      runtimeUrls,
      scanSwitcher,
      switchVersion,
      userVariants,
    };
  }
})();
