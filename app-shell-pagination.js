(function () {
  "use strict";

  const VERSION = "0.6.3 Beta 4";
  // Development diagnostics are disabled in release builds. Set DEBUG to true
  // locally when a live AppShell investigation needs an in-memory event log.
  const DEBUG = false;
  const TEST_MODE = globalThis.__CHATGPT_EDIT_PAGINATION_PATCH_TEST__ === true;
  const DIAGNOSTICS_ENABLED = DEBUG || TEST_MODE;
  const SHELL_ATTRIBUTE = "data-codex-window-type";
  const USER_BUBBLE = "[data-user-message-bubble]";
  const ASSISTANT_MESSAGE = "[data-chatgpt-selection-message-id]";
  const MORE_ACTIONS_BUTTON = 'button[aria-label="More actions"], button[aria-label="Ещё действия"]';
  const MODEL_INFO = "[data-message-model-info]";
  const CONTROLS = "[data-batch-edit-pagination]";
  const ASSISTANT_CONTROLS = "[data-batch-assistant-pagination]";
  const NATIVE_VERSIONS_BUTTON = [
    'button[aria-label="See versions"]',
    'button[aria-label="Посмотреть версии"]',
    'button[aria-label="Просмотреть версии"]',
  ].join(", ");
  const RUNTIME_HINT = /^\/cdn\/assets\/633146\.[a-z0-9]+\.js$/;
  const MAX_GRAPHS = 3;
  const MAX_EVENTS = 500;
  const graphs = new Map();
  const scopeAdapters = new WeakMap();
  const controlMessages = new WeakMap();
  const pendingConversations = new Set();
  const historyLoads = new Map();
  const activityWatches = new Set();
  const disabledNativeButtons = new Map();
  const guardedNativeButtons = new WeakSet();
  const conversationErrors = new Map();
  const attemptedRuntimeUrls = new Set();
  const warned = new Set();
  const wrappedHistoryFactories = new WeakSet();
  const historyLoaders = new WeakMap();
  const diagnostics = DIAGNOSTICS_ENABLED ? {
    version: VERSION,
    installedAt: new Date().toISOString(),
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
    fullHistoryLoads: 0,
    events: [],
  } : null;
  let runtime = null;
  let switcher = null;
  let switcherModuleIds = [];
  let activityAdapter = null;
  let resolveNativeConversationId = null;
  let identityScanSize = -1;
  let runtimeDiscovery = null;
  let frame = null;
  let observer = null;
  let rootObserver = null;
  let stopped = false;
  let pass = 0;
  let graphRevision = 0;
  let historyRegistration = null;

  const record = (type, details = {}) => {
    if (!diagnostics) return;
    diagnostics.events.push({ at: new Date().toISOString(), type, ...details });
    if (diagnostics.events.length > MAX_EVENTS) diagnostics.events.splice(0, diagnostics.events.length - MAX_EVENTS);
  };

  const warnOnce = (key, message, details = {}) => {
    if (warned.has(key)) return;
    warned.add(key);
    const build = document.documentElement?.getAttribute("data-build") ?? "unknown";
    console.warn(`[Edit Pagination][AppShell] ${message} (build ${build})`, details);
    record("warning", { key, message, build, ...details });
  };

  const isShell = () => document.documentElement?.hasAttribute(SHELL_ATTRIBUTE) === true;

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

  const mergeMappings = (batchMapping, liveMapping, authoritative = true) => {
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
        // Only a full server graph can override the synthetic parent of a
        // paginated slice. A cached slice must accept native prepend updates.
        parent: authoritative ? batchNode.parent : liveNode.parent,
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

  const createGraphState = (payload, authoritative = true) => {
    if (!payload || typeof payload !== "object" || !payload.mapping || typeof payload.mapping !== "object") {
      return null;
    }
    const conversationId = String(payload.conversation_id ?? payload.id ?? "");
    if (!conversationId) return null;
    const batchMapping = cloneMapping(payload.mapping);
    return {
      conversationId,
      currentNode: typeof payload.current_node === "string" ? payload.current_node : null,
      authoritative,
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

  const readContext = (message) => {
    if (diagnostics) diagnostics.contextScans++;
    const assistantId = message.getAttribute("data-chatgpt-selection-message-id");
    const itemType = message.matches(USER_BUBBLE) ? "user-message" : "assistant-message";
    const key = getFiber(message);
    let fiber = currentFiber(key ? message[key] : null);
    let scope = null;
    let context = null;
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
      scope ??= scopeInHooks(fiber.memoizedState);
      const props = fiber.memoizedProps;
      if (!context && props && typeof props === "object" &&
          props.item?.type === itemType && typeof props.item.messageId === "string" &&
          (itemType === "user-message" || props.item.messageId === assistantId) &&
          typeof props.conversationId === "string") {
        context = { conversationId: props.conversationId, messageId: props.item.messageId };
      }
    }
    return scope && context ? { ...context, scope } : null;
  };

  const scanConversationIdentity = () => {
    if (resolveNativeConversationId || !runtime?.c || !runtime?.m) return;
    const modules = Object.entries(runtime.c);
    if (modules.length === identityScanSize) return;
    identityScanSize = modules.length;
    // The native mapping resolver follows the local-chatgpt identity family.
    // Inspect loaded exports only; do not initialize other client modules.
    const identityModules = Object.entries(runtime.m)
      .filter(([, factory]) => candidateSource(factory).includes('"local-chatgpt:"'))
      .map(([id]) => id);
    const candidates = new Set();
    for (const [id, module] of modules) {
      const factorySource = candidateSource(runtime.m[id]);
      if (!identityModules.some((identityId) => factorySource.includes(`("${identityId}")`))) continue;
      let names;
      try { names = Object.keys(module?.exports ?? {}); } catch { continue; }
      for (const name of names) {
        let candidate;
        try { candidate = module.exports[name]; } catch { continue; }
        if (typeof candidate !== "function" || candidate.length !== 2) continue;
        const source = candidateSource(candidate).replace(/\s+/g, "");
        if (/^function[^(]*\([^)]*\)\{returnnull==[^{}]+\?\?[^{}]+\}$/.test(source)) candidates.add(candidate);
      }
    }
    if (candidates.size === 1) resolveNativeConversationId = [...candidates][0];
  };

  const conversationKey = (context) => {
    const id = context?.conversationId;
    if (typeof id !== "string" || !id) return null;
    if (!id.startsWith("local-chatgpt:") || !context.scope) return id;
    if (!resolveNativeConversationId) scanConversationIdentity();
    if (resolveNativeConversationId) {
      try {
        const resolved = resolveNativeConversationId((atom, key) => context.scope.get(atom, key), id);
        if (typeof resolved === "string" && resolved) return resolved;
      } catch {
        // An unregistered local conversation retains its own isolated key.
      }
    }
    return id;
  };

  const ownsGraph = (context, graph) => graph?.conversationId === conversationKey(context);

  const nativeConversationBusy = (scope, conversationId) => {
    if (!activityAdapter) return true;
    try {
      const busy = activityAdapter.read(scope, conversationId);
      return typeof busy === "boolean" ? busy : true;
    } catch {
      return true;
    }
  };

  const conversationBusy = (context) => {
    const id = conversationKey(context);
    return pendingConversations.has(id) || historyLoads.has(id) ||
      historyLoads.has(context.conversationId) ||
      nativeConversationBusy(context.scope, context.conversationId);
  };

  const watchConversationActivity = (context, currentPass) => {
    const owner = context.scope.node ?? context.scope;
    let entry = [...activityWatches].find((item) =>
      item.owner === owner && item.conversationId === context.conversationId);
    if (entry) {
      entry.pass = currentPass;
      return;
    }
    if (!activityAdapter || typeof context.scope.watch !== "function") return;
    entry = { owner, conversationId: context.conversationId, pass: currentPass, busy: undefined, stop: null };
    activityWatches.add(entry);
    try {
      entry.stop = context.scope.watch((scope) => {
        const busy = nativeConversationBusy(scope, entry.conversationId);
        if (busy !== entry.busy) {
          entry.busy = busy;
          schedule();
        }
      });
    } catch (error) {
      activityWatches.delete(entry);
      warnOnce("activity-watch", "The conversation activity subscription could not be installed.", { error: String(error) });
    }
  };

  const releaseActivityWatches = (currentPass) => {
    for (const entry of activityWatches) {
      if (entry.pass === currentPass) continue;
      if (typeof entry.stop === "function") entry.stop();
      activityWatches.delete(entry);
    }
  };

  const restoreNativeButton = (button, originalDisabled) => {
    // React commits host props here; Fiber/alternate props can still describe
    // the busy render. Restore the native value, including an omitted false.
    const propsKey = Object.getOwnPropertyNames(button)
      .find((name) => name.startsWith("__reactProps$"));
    const key = propsKey ? null : getFiber(button);
    const props = propsKey ? button[propsKey] : currentFiber(key ? button[key] : null)?.memoizedProps;
    button.disabled = props && typeof props === "object" ? Boolean(props.disabled) : originalDisabled;
  };

  const releaseNativeButton = (button, saved) => {
    saved.observer.disconnect();
    disabledNativeButtons.delete(button);
    restoreNativeButton(button, saved.originalDisabled);
  };

  const blockNativeAssistantButtons = (wrapper, message, busy, currentPass) => {
    for (const button of wrapper.querySelectorAll("button")) {
      controlMessages.set(button, message);
      if (!guardedNativeButtons.has(button)) {
        button.addEventListener("click", (event) => {
          const owner = controlMessages.get(button);
          const context = owner?.isConnected ? readContext(owner) : null;
          if (context && conversationBusy(context)) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }, true);
        guardedNativeButtons.add(button);
      }
      let saved = disabledNativeButtons.get(button);
      if (busy) {
        if (!saved) {
          // A native React commit can change disabled while our operation is
          // still pending. Observe only this arrow, only while we hold it.
          const disabledObserver = new MutationObserver(() => {
            if (stopped || button.disabled || !disabledNativeButtons.has(button)) return;
            const owner = controlMessages.get(button);
            const context = button.isConnected && owner?.isConnected ? readContext(owner) : null;
            if (context && conversationBusy(context)) button.disabled = true;
            else schedule();
          });
          saved = { originalDisabled: button.disabled, pass: currentPass, observer: disabledObserver };
          disabledNativeButtons.set(button, saved);
          disabledObserver.observe(button, { attributes: true, attributeFilter: ["disabled"] });
        }
        saved.pass = currentPass;
        if (!button.disabled) button.disabled = true;
      } else if (saved) {
        releaseNativeButton(button, saved);
      }
    }
  };

  const releaseNativeButtons = (currentPass) => {
    for (const [button, saved] of disabledNativeButtons) {
      if (saved.pass === currentPass) continue;
      releaseNativeButton(button, saved);
    }
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
    const conversationId = conversationKey(context);
    const cache = adapterCacheFor(context.scope);
    const cached = cache.get(conversationId);
    if (cached) {
      try {
        context.scope.get(cached.mappingSignal, conversationId);
        return cached;
      } catch {
        cache.delete(conversationId);
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
        value = context.scope.get(atom, conversationId);
      } catch {
        continue;
      }
      const score = mappingScore(value, graph, context.messageId);
      if (score < 0 || (best && best.score >= score)) continue;
      best = { mappingSignal: atom, score };
    }
    if (!best) return null;
    const adapter = { mappingSignal: best.mappingSignal, lastApplied: null, lastRevision: 0 };
    cache.set(conversationId, adapter);
    if (diagnostics) {
      record("scope-adapter-found", {
        conversationId: context.conversationId,
        mappingScore: best.score,
      });
    }
    return adapter;
  };

  const restoreGraphFromScope = (context) => {
    const conversationId = conversationKey(context);
    const adapter = discoverScopeAdapter(context, null);
    if (!adapter) return null;
    let liveMapping;
    try {
      liveMapping = context.scope.get(adapter.mappingSignal, conversationId);
    } catch {
      return null;
    }
    const graph = createGraphState({
      id: conversationId,
      current_node: context.messageId,
      mapping: liveMapping,
    }, false);
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
    const graph = graphs.get(conversationKey(context));
    if (!graph) return context.scope ? restoreGraphFromScope(context) : null;
    graphs.delete(graph.conversationId);
    graphs.set(graph.conversationId, graph);
    return graph;
  };

  const hydrateGraph = (context, graph) => {
    const conversationId = conversationKey(context);
    if (!graph || graph.conversationId !== conversationId) return false;
    // Loading and native conversation operations own the live graph while busy.
    // This guard also covers reconciliation, not just arrow click handlers.
    if (conversationBusy(context)) return false;
    const adapter = discoverScopeAdapter(context, graph);
    if (!adapter) return false;
    let liveMapping;
    try {
      liveMapping = context.scope.get(adapter.mappingSignal, conversationId);
    } catch (error) {
      if (diagnostics) {
        diagnostics.scopeHydrationFailures++;
        record("scope-hydration-failed", { conversationId: context.conversationId, error: String(error) });
      }
      return false;
    }
    if (conversationKey(context) !== conversationId) return false;
    if (liveMapping === adapter.lastApplied && adapter.lastRevision === graph.revision) return true;
    const merged = mergeMappings(graph.liveMapping ?? graph.batchMapping, liveMapping, graph.authoritative);
    graph.liveMapping = merged;
    graph.mapping = compactMapping(merged);
    if (!graph.authoritative) {
      // Read partial native state without writing cached pagination boundaries
      // back into AppScope. Older-page loading owns these links.
      adapter.lastApplied = liveMapping;
      adapter.lastRevision = graph.revision;
      return true;
    }
    try {
      if (!ownsGraph(context, graph) || conversationBusy(context)) return false;
      context.scope.set(adapter.mappingSignal, conversationId, merged);
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
      failed: "Не удалось переключить версию сообщения.",
    }
    : {
      previous: "Previous version",
      next: "Next version",
      group: "Message versions",
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
    const conversationId = conversationKey(context);
    if (conversationBusy(context)) return;
    const graph = graphs.get(conversationId);
    if (!ownsGraph(context, graph) || !graph.mapping[currentMessageId] || !graph.mapping[targetMessageId]) return;
    pendingConversations.add(conversationId);
    conversationErrors.delete(conversationId);
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
      conversationErrors.set(conversationId, failureMessage);
      if (diagnostics) record("switch-failed", { conversationId: context.conversationId, targetMessageId, error: String(error) });
      warnOnce("switch-failed", failureMessage, { error: String(error) });
    } finally {
      pendingConversations.delete(conversationId);
      schedule();
    }
  };

  const switchVersion = async (bubble, direction) => {
    if (!bubble?.isConnected) return;
    const context = readContext(bubble);
    if (!context || conversationBusy(context)) return;
    const graph = graphFor(context);
    if (!graph || !hydrateGraph(context, graph)) return;
    const ids = userVariants(graph, context.messageId);
    const index = ids.indexOf(context.messageId);
    const target = index < 0 ? null : ids[index + direction];
    if (!target) return;
    await requestSwitch(context, context.messageId, target, labels().failed);
  };

  const retainBusyControls = (controls, message, context, currentPass, busy) => {
    if (!busy || !controls || controls.dataset.conversationId !== conversationKey(context)) return false;
    controlMessages.set(controls, message);
    controls.dataset.messageId = context.messageId;
    controls.dataset.pass = String(currentPass);
    controls.setAttribute("aria-busy", "true");
    for (const button of controls.querySelectorAll("button")) button.disabled = true;
    return true;
  };

  const paintUserPagination = (bubble, context, graph, mountInfo, currentPass, busy) => {
    const ids = userVariants(graph, context.messageId);
    const index = ids.indexOf(context.messageId);
    const { mount } = mountInfo;
    let controls = mount.querySelector(CONTROLS);
    if (ids.length < 2 || index < 0) {
      if (retainBusyControls(controls, bubble, context, currentPass, busy)) return true;
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
        void switchVersion(controlMessages.get(controls), -1);
      });
      const counter = document.createElement("span");
      counter.setAttribute("aria-live", "polite");
      counter.setAttribute("aria-atomic", "true");
      const next = createButton(text.next, 1, (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchVersion(controlMessages.get(controls), 1);
      });
      controls.append(previous, counter, next);
    }
    controlMessages.set(controls, bubble);
    controls.dataset.pass = String(currentPass);
    controls.dataset.conversationId = graph.conversationId;
    controls.dataset.messageId = context.messageId;
    if (controls.parentElement !== mount) mount.append(controls);
    const [previous, counter, next] = controls.children;
    const caption = `${index + 1}/${ids.length}`;
    if (counter.textContent !== caption) counter.textContent = caption;
    previous.disabled = busy || index === 0;
    next.disabled = busy || index === ids.length - 1;
    controls.setAttribute("aria-busy", String(busy));
    const error = conversationErrors.get(graph.conversationId) ?? "";
    controls.title = error;
    counter.setAttribute("aria-label", error ? `${caption}. ${error}` : caption);
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

  const modelInfoFor = (context, graph) => {
    if (!ownsGraph(context, graph)) return null;
    const saved = graph.batchMapping?.[context.messageId]?.message;
    const live = graph.liveMapping?.[context.messageId]?.message;
    if ((live ?? saved)?.author?.role !== "assistant") return null;
    const metadata = { ...saved?.metadata, ...live?.metadata };
    const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
    const modelSlug = text(metadata.model_slug) ?? text(metadata.resolved_model_slug);
    if (!modelSlug) return null;
    return { modelSlug, effort: text(metadata.thinking_effort) };
  };

  const modelCaptionFor = (info, scope) => {
    const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
    const effortKey = (value) => {
      const effort = text(value);
      return effort === "none" ? null : effort;
    };
    const join = (model, label) => !label || model.toLowerCase().endsWith(` ${label.toLowerCase()}`) ||
      model.toLowerCase() === label.toLowerCase() ? model : `${model} ${label}`;
    const effort = effortKey(info.effort);
    let modelTitle = null;
    let effortLabel = null;
    try {
      // Read the client's existing Chat/Work catalogs; never fetch another catalog.
      const client = scope?.queryClient ?? scope?.node?.queryClient;
      const queries = client?.getQueryCache?.()?.getAll?.();
      for (const query of Array.isArray(queries) ? queries : []) {
        const catalog = query.state?.data;
        if (!catalog || typeof catalog !== "object") continue;
        const groups = [catalog, ...(Array.isArray(catalog.versionOptions) ? catalog.versionOptions : [])];
        for (const group of groups) {
          for (const option of Array.isArray(group?.options) ? group.options : []) {
            if (option?.slug !== info.modelSlug || effortKey(option.thinkingEffort) !== effort) continue;
            const model = text(option.selectedDisplayVersion);
            const label = text(option.selectedLabel);
            if (model && label) return join(model, label);
          }
        }
        const config = catalog.modelConfigBySlug?.[info.modelSlug];
        modelTitle ??= text(config?.title)?.replace(/^GPT[-\s]?/i, "");
        const levels = config?.thinkingEfforts;
        const level = Array.isArray(levels) ? levels.find((entry) => effortKey(entry?.thinking_effort) === effort) : null;
        effortLabel ??= text(level?.short_label);
      }
    } catch {
      // A missing or changed catalog must not break the native menu or invent a mode.
    }
    if (!modelTitle) {
      const match = /^gpt-(\d+(?:[.-]\d+)*)(?:[-.](.+))?$/i.exec(info.modelSlug);
      if (match) {
        const version = match[1].replaceAll("-", ".");
        const name = (match[2] ?? "").replace(/(?:^|-)wm$/i, "").split("-")
          .filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
        modelTitle = join(version, name);
      } else modelTitle = info.modelSlug;
    }
    if (effortLabel) return join(modelTitle, effortLabel);
    return effort ? `${modelTitle} (${effort})` : modelTitle;
  };

  const assistantMessageForMenu = (menu) => {
    const triggerId = menu.getAttribute("aria-labelledby");
    const trigger = triggerId ? document.getElementById(triggerId) : null;
    if (!trigger?.matches(MORE_ACTIONS_BUTTON) || trigger.getAttribute("aria-expanded") !== "true" ||
        (trigger.hasAttribute("aria-controls") && trigger.getAttribute("aria-controls") !== menu.id)) return null;
    const row = trigger.closest(".turn-action-controls");
    if (!row) return null;
    let element = row.parentElement;
    for (let depth = 0; element && depth < 10; depth++, element = element.parentElement) {
      const messages = element.querySelectorAll(ASSISTANT_MESSAGE);
      if (messages.length === 1 && assistantActionRowFor(messages[0]) === row) return messages[0];
    }
    return null;
  };

  const reconcileModelInfoMenus = () => {
    for (const menu of document.querySelectorAll('[role="menu"][aria-labelledby]')) {
      const message = assistantMessageForMenu(menu);
      const context = message ? readContext(message) : null;
      const graph = context ? graphFor(context) : null;
      const info = context ? modelInfoFor(context, graph) : null;
      let row = menu.querySelector(MODEL_INFO);
      if (!info) {
        row?.remove();
        continue;
      }
      if (!row) {
        row = document.createElement("div");
        row.setAttribute("data-message-model-info", "");
        row.setAttribute("role", "note");
        // Preserve the native date and actions, including their React handlers.
        menu.insertBefore(row, menu.children[1] ?? null);
      }
      row.dataset.conversationId = graph.conversationId;
      row.dataset.messageId = context.messageId;
      const caption = `GPT-${modelCaptionFor(info, context.scope).replace(/^GPT[-\s]+/i, "")}`;
      if (row.textContent !== caption) row.textContent = caption;
    }
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
    const more = row.querySelector(MORE_ACTIONS_BUTTON);
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

  const switchAssistantVersion = async (message, direction) => {
    if (!message?.isConnected) return;
    const context = readContext(message);
    if (!context || conversationBusy(context)) return;
    const graph = graphFor(context);
    if (!graph || !hydrateGraph(context, graph)) return;
    const messageId = context.messageId;
    const ids = assistantVariants(graph, messageId);
    const index = ids.indexOf(messageId);
    const target = index < 0 ? null : ids[index + direction];
    if (!target) return;
    await requestSwitch(context, messageId, target, assistantLabels().failed);
  };

  const paintAssistantPagination = (message, context, graph, row, currentPass, busy) => {
    const messageId = message.getAttribute("data-chatgpt-selection-message-id");
    if (!messageId) return false;
    suppressNativeVersions(row, { role: "assistant", messageId });
    const ids = assistantVariants(graph, messageId);
    const index = ids.indexOf(messageId);
    const native = nativeAssistantPaginationFor(row);
    let controls = row.querySelector(ASSISTANT_CONTROLS);
    if (native) {
      blockNativeAssistantButtons(native, message, busy, currentPass);
      if (busy) {
        // The cached graph may not yet contain the new streaming response.
        // Do not hide native arrows as "phantom" while its state is changing.
        controls?.remove();
        return false;
      }
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
      if (retainBusyControls(controls, message, context, currentPass, busy)) return true;
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
        void switchAssistantVersion(controlMessages.get(controls), -1);
      });
      const counter = document.createElement("span");
      counter.setAttribute("aria-live", "polite");
      counter.setAttribute("aria-atomic", "true");
      const next = createButton(text.next, 1, (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchAssistantVersion(controlMessages.get(controls), 1);
      });
      controls.append(previous, counter, next);
    }
    controlMessages.set(controls, message);
    controls.dataset.pass = String(currentPass);
    controls.dataset.conversationId = graph.conversationId;
    controls.dataset.messageId = messageId;
    const { mount, insertionPoint } = assistantPaginationMount(row);
    if (controls.parentElement !== mount || (insertionPoint && controls.nextElementSibling !== insertionPoint)) {
      mount.insertBefore(controls, insertionPoint);
    }
    const [previous, counter, next] = controls.children;
    const caption = `${index + 1}/${ids.length}`;
    if (counter.textContent !== caption) counter.textContent = caption;
    previous.disabled = busy || index === 0;
    next.disabled = busy || index === ids.length - 1;
    controls.setAttribute("aria-busy", String(busy));
    const error = conversationErrors.get(graph.conversationId) ?? "";
    controls.title = error;
    counter.setAttribute("aria-label", error ? `${caption}. ${error}` : caption);
    return true;
  };

  const reconcileAssistantPagination = (currentPass) => {
    let painted = 0;
    for (const message of document.querySelectorAll(ASSISTANT_MESSAGE)) {
      const messageId = message.getAttribute("data-chatgpt-selection-message-id");
      if (!messageId) continue;
      const context = readContext(message);
      if (!context) continue;
      watchConversationActivity(context, currentPass);
      const graph = graphFor(context);
      const busy = conversationBusy(context);
      if (!graph && !busy) continue;
      if (!busy && !hydrateGraph(context, graph)) continue;
      const row = assistantActionRowFor(message);
      if (!row) continue;
      if (paintAssistantPagination(message, context, graph, row, currentPass, busy)) painted++;
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

  const isHistoryLoaderSource = (source) => source.includes("forceFull") &&
    source.includes("/conversations/{conversation_id}") &&
    source.includes("/conversation/{conversation_id}") &&
    source.includes("include_has_versions");

  const captureFullHistory = (payload, conversationId, scope) => {
    const expectedId = conversationKey({ conversationId, scope });
    if (!payload?.mapping || typeof payload.mapping !== "object" ||
        Array.isArray(payload.mapping) ||
        String(payload.conversation_id ?? payload.id ?? "") !== expectedId ||
        (Object.hasOwn(payload.mapping, `paginated-root:${expectedId}`) ||
         Object.hasOwn(payload.mapping, `paginated-root:${conversationId}`))) return;
    const graph = createGraphState(payload);
    if (!graph) return;
    storeGraph(graph);
    record("full-history-captured", { conversationId });
    schedule();
  };

  const wrapHistoryLoader = (original) => {
    if (historyLoaders.has(original)) return historyLoaders.get(original);
    const wrapped = function fullHistoryLoader(scope, conversationId, options) {
      if (!isShell() || options === null || options?.isTemporaryChat === true) {
        return Reflect.apply(original, this, arguments);
      }
      const args = [...arguments];
      args[2] = { ...options, forceFull: true };
      if (args[2].initialResponse?.mapping &&
          (Object.hasOwn(args[2].initialResponse.mapping, `paginated-root:${conversationId}`) ||
           Object.hasOwn(args[2].initialResponse.mapping, `paginated-root:${conversationKey({ scope, conversationId })}`))) {
        // The native loader returns any mapping-shaped initialResponse before
        // checking forceFull. Do not let a provisional slice bypass full load.
        delete args[2].initialResponse;
      }
      const loadId = conversationKey({ scope, conversationId });
      historyLoads.set(loadId, (historyLoads.get(loadId) ?? 0) + 1);
      schedule();
      const finish = () => {
        const remaining = (historyLoads.get(loadId) ?? 1) - 1;
        if (remaining) historyLoads.set(loadId, remaining);
        else historyLoads.delete(loadId);
        schedule();
      };
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { finish(); throw error; }
      if (diagnostics) diagnostics.fullHistoryLoads++;
      return result.then((payload) => {
        try {
          captureFullHistory(payload, String(conversationId), scope);
        } catch (error) {
          warnOnce("full-history-capture", "The full history could not be captured for version arrows.", {
            error: String(error),
          });
        }
        return payload;
      }).finally(finish);
    };
    historyLoaders.set(original, wrapped);
    return wrapped;
  };

  const wrapHistoryFactory = (factory) => {
    if (wrappedHistoryFactories.has(factory)) return factory;
    const wrapped = function historyFactory(module, exports, require) {
      const localRequire = function (...args) { return Reflect.apply(require, this, args); };
      Object.setPrototypeOf(localRequire, require);
      localRequire.d = function (target, getters, values) {
        if (target !== exports) return require.d(target, getters, values);
        const nextGetters = { ...getters };
        const nextValues = { ...values };
        for (const [name, getter] of Object.entries(getters ?? {})) {
          let initialized = false;
          let previous;
          let replacement;
          nextGetters[name] = function historyExport() {
            // Native exports may be declared before a const/let binding exists.
            // Read them only when their consumer does, not during registration.
            const candidate = Reflect.apply(getter, this, arguments);
            if (initialized && candidate === previous) return replacement;
            initialized = true;
            previous = candidate;
            replacement = candidate;
            if (typeof candidate === "function" && isHistoryLoaderSource(candidateSource(candidate))) {
              replacement = wrapHistoryLoader(candidate);
              record("full-history-loader-installed", { exportName: name });
            }
            return replacement;
          };
        }
        for (const [name, candidate] of Object.entries(values ?? {})) {
          if (typeof candidate === "function" && isHistoryLoaderSource(candidateSource(candidate))) {
            nextValues[name] = wrapHistoryLoader(candidate);
          }
        }
        return require.d(target, nextGetters, nextValues);
      };
      return Reflect.apply(factory, this, [module, exports, localRequire]);
    };
    wrappedHistoryFactories.add(wrapped);
    return wrapped;
  };

  const installHistoryFactories = (factories, cache) => {
    if (!factories) return false;
    const known = typeof factories.O4 === "function" &&
      isHistoryLoaderSource(candidateSource(factories.O4));
    const entries = known ? [["O4", factories.O4]] : Object.entries(factories);
    for (const [moduleId, factory] of entries) {
      if (typeof factory !== "function" || !isHistoryLoaderSource(candidateSource(factory))) continue;
      if (cache?.[moduleId]) {
        warnOnce("full-history-late", "The history loader was already initialized. Reload with the updated extension to enable full history.");
        return false;
      }
      factories[moduleId] = wrapHistoryFactory(factory);
      record("full-history-factory-installed", { moduleId });
      return true;
    }
    return false;
  };

  const installFullHistory = (candidate) => {
    if (!isShell() || typeof candidate?.C !== "function" || typeof candidate.d !== "function") return false;
    if (installHistoryFactories(candidate.m, candidate.c)) return true;
    const original = candidate.C;
    const register = function registerHistory(chunk) {
      if (installHistoryFactories(chunk?.__webpack_modules__, candidate.c)) {
        if (candidate.C === register) candidate.C = original;
        historyRegistration = null;
      }
      return Reflect.apply(original, this, arguments);
    };
    candidate.C = register;
    historyRegistration = { candidate, original, register };
    return true;
  };

  const scanConversationActivity = () => {
    if (activityAdapter || !switcher) return;
    // Follow the signals used by this exact native selector, rather than
    // guessing busy state from DOM changes or initializing other modules.
    try {
      const selectorSource = candidateSource(switcher).replace(/\s+/g, "");
      const guard = selectorSource.match(
        /if\(\w+\.get\((\w+)\.(\w+),\w+\)\|\|null==\w+\|\|\(0,\1\.(\w+)\)\(\w+\.get\(\1\.(\w+),\w+\)\)/,
      );
      // A barrel can re-export the same selector but its local variable names
      // belong to a different closure. Resolve dependencies only in the factory
      // that actually defines this function, not the first export encountered.
      const factory = switcherModuleIds.map(id => candidateSource(runtime.m?.[id]))
        .find(source => source.replace(/\s+/g, "").includes(selectorSource));
      const dependency = guard && factory?.match(new RegExp(`\\b${guard[1]}=\\w+\\(["']([^"']+)["']\\)`));
      const state = dependency && runtime.c[dependency[1]]?.exports;
      if (state && state[guard[2]]?.kind === "readable-family" &&
          state[guard[4]]?.kind === "readable-family" && typeof state[guard[3]] === "function") {
        const busySignal = state[guard[2]], statusSignal = state[guard[4]], classify = state[guard[3]];
        activityAdapter = {
          read(scope, id) {
            const switching = scope.get(busySignal, id);
            const active = classify(scope.get(statusSignal, id));
            return typeof switching === "boolean" && typeof active === "boolean" ? switching || active : null;
          },
        };
        schedule();
        return;
      }
    } catch {
      // A lazily registered module may still have uninitialized export bindings.
    }
    warnOnce("activity-missing", "The native conversation activity signals could not be identified yet.");
  };

  const scanSwitcher = () => {
    if (switcher) { scanConversationActivity(); return switcher; }
    if (!runtime?.c) return null;
    if (diagnostics) diagnostics.switcherScans++;
    const hits = [];
    const seen = new Map();
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
          const existing = seen.get(candidate);
          if (existing) { existing.moduleIds.add(moduleId); continue; }
          const hit = { moduleId, exportName, candidate, moduleIds: new Set([moduleId]) };
          seen.set(candidate, hit);
          hits.push(hit);
        }
      }
    }
    if (hits.length === 1) {
      switcher = hits[0].candidate;
      switcherModuleIds = [...hits[0].moduleIds];
      scanConversationActivity();
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
    scanConversationIdentity();
    installFullHistory(candidate);
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
      for (const info of document.querySelectorAll(MODEL_INFO)) info.remove();
      releaseActivityWatches(currentPass);
      releaseNativeButtons(currentPass);
      return;
    }
    if (!runtime) void discoverRuntime();
    const bubbles = [...document.querySelectorAll(USER_BUBBLE)];
    let painted = 0;
    for (const bubble of bubbles) {
      const mountInfo = findMount(bubble);
      if (!mountInfo) continue;
      suppressNativeVersions(mountInfo.row, { role: "user" });
      const context = readContext(bubble);
      if (!context) continue;
      watchConversationActivity(context, currentPass);
      const graph = graphFor(context);
      const busy = conversationBusy(context);
      if (!graph && !busy) continue;
      if (!busy && !hydrateGraph(context, graph)) continue;
      if (paintUserPagination(bubble, context, graph, mountInfo, currentPass, busy)) painted++;
    }
    const assistantPainted = reconcileAssistantPagination(currentPass);
    reconcileModelInfoMenus();
    releaseActivityWatches(currentPass);
    releaseNativeButtons(currentPass);
    for (const controls of document.querySelectorAll(CONTROLS)) {
      if (controls.dataset.pass !== String(currentPass)) controls.remove();
    }
    if (diagnostics) record("render", { bubbleCount: bubbles.length, painted, assistantPainted, graphCount: graphs.size });
    if (bubbles.length && graphs.size && !runtime) void discoverRuntime();
    else if (runtime && (!switcher || !activityAdapter)) scanSwitcher();
  };

  function schedule() {
    if (stopped || frame !== null || typeof requestAnimationFrame !== "function") return;
    frame = requestAnimationFrame(reconcile);
  }

  const mutationMatters = (mutation) => {
    if (mutation.target?.nodeType === 1 && mutation.target.closest?.(MODEL_INFO)) return false;
    if (mutation.type === "attributes") return true;
    if (mutation.target?.nodeType === 1 && mutation.target.closest?.(".turn-action-controls")) return true;
    if (mutation.target?.nodeType === 1 && mutation.target.closest?.('[role="menu"]')) return true;
    const relevant = (node) => node.nodeType === 1 &&
      (node.matches?.(USER_BUBBLE) || node.querySelector?.(USER_BUBBLE) ||
       node.matches?.(".turn-action-controls") || node.querySelector?.(".turn-action-controls") ||
       node.matches?.('[role="menu"]') || node.querySelector?.('[role="menu"]') ||
       node.matches?.('link[rel="modulepreload"]'));
    return [...mutation.addedNodes, ...mutation.removedNodes].some(relevant);
  };

  const observe = () => {
    const root = document.documentElement;
    if (!root || observer) return;
    observer = new MutationObserver((mutations) => {
      if (isShell() && !runtime) void discoverRuntime();
      if (mutations.some(mutationMatters)) schedule();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [SHELL_ATTRIBUTE, "data-user-message-bubble", "data-chatgpt-selection-message-id", "aria-expanded", "aria-labelledby"],
    });
    if (isShell() && !runtime) void discoverRuntime();
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
    link.download = `chatgpt-version-arrows-appshell-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

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
    releaseActivityWatches(-1);
    releaseNativeButtons(-1);
    if (historyRegistration && historyRegistration.candidate.C === historyRegistration.register) {
      historyRegistration.candidate.C = historyRegistration.original;
    }
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
      captureFullHistory,
      conversationKey,
      conversationBusy,
      createGraphState,
      currentFiber,
      graphFor,
      graphSummary,
      getGraphSummaryRuns: () => diagnostics.graphSummaries,
      hydrateGraph,
      installFullHistory,
      wrapHistoryLoader,
      mergeMappings,
      mutationMatters,
      modelInfoFor,
      modelCaptionFor,
      readContext,
      reconcileModelInfoMenus,
      runtimeUrls,
      scanSwitcher,
      setActivityAdapter: (adapter) => { activityAdapter = adapter; schedule(); },
      userVariants,
    };
  }
})();
