(function () {
  "use strict";

  let presentation, branch;
  dispatchEvent(new CustomEvent("chatgpt-version-arrows:text-connect", { detail: (value) => { presentation = value; } }));
  dispatchEvent(new CustomEvent("chatgpt-version-arrows:branch-connect", { detail: (value) => { branch = value; } }));
  if (!presentation || !branch) return;

  // Loaded before the arrows. Without this listener their optional connection
  // has no effect, and this module never creates a second history loader.
  addEventListener("chatgpt-version-arrows:connect", (event) => event.detail((api) => {
    const { USER_BUBBLE, ASSISTANT_MESSAGE, readContext, conversationKey, conversationBusy,
      graphFor, hydrateGraph, requestSwitch, clientText, getFiber, currentFiber, isShell, schedule,
      watchActivity, isStopped } = api;
    let routeKey = location.pathname + location.hash;

  const CARD = Object.freeze({ width: 256, height: 128 });
  const ROW_STEP = CARD.height + 48;
  const COLUMN_STEP = CARD.width + 32;

  // A tidy tree packs neighbouring subtree contours at each depth, instead of
  // reserving a column for every leaf. Threads and deferred shifts keep the
  // Buchheim/Walker layout linear; explicit stacks also handle long chats.
  function* layoutMessageTree(nodes, roots) {
    let operations = 0;
    const makeLayout = (node, parent, index) => {
      const layout = { node, parent, index, children: [], prelim: 0, modifier: 0,
        change: 0, shift: 0, thread: null, ancestor: null, defaultAncestor: null };
      layout.ancestor = layout;
      return layout;
    };
    const root = makeLayout(null, null, 0);
    root.children = roots.map((id, index) => makeLayout(nodes.get(id), root, index));
    const build = root.children.slice();
    while (build.length) {
      const layout = build.pop();
      layout.children = layout.node.children.map((id, index) => makeLayout(nodes.get(id), layout, index));
      for (const child of layout.children) {
        build.push(child);
        if (++operations % 256 === 0) yield;
      }
      if (++operations % 256 === 0) yield;
    }
    const leftContour = (layout) => layout.children[0] ?? layout.thread;
    const rightContour = (layout) => layout.children.at(-1) ?? layout.thread;
    const moveSubtree = (left, right, distance) => {
      const change = distance / (right.index - left.index);
      right.change -= change;
      right.shift += distance;
      left.change += change;
      right.prelim += distance;
      right.modifier += distance;
    };
    function* pack(layout, previous, ancestor) {
      if (!previous) return ancestor;
      let innerLeft = previous, innerRight = layout;
      let outerLeft = layout.parent.children[0], outerRight = layout;
      let innerLeftMod = innerLeft.modifier, innerRightMod = innerRight.modifier;
      let outerLeftMod = outerLeft.modifier, outerRightMod = outerRight.modifier;
      while (true) {
        innerLeft = rightContour(innerLeft);
        innerRight = leftContour(innerRight);
        if (!innerLeft || !innerRight) break;
        outerLeft = leftContour(outerLeft);
        outerRight = rightContour(outerRight);
        outerRight.ancestor = layout;
        const distance = innerLeft.prelim + innerLeftMod - innerRight.prelim - innerRightMod + COLUMN_STEP;
        if (distance > 0) {
          const left = innerLeft.ancestor.parent === layout.parent ? innerLeft.ancestor : ancestor;
          moveSubtree(left, layout, distance);
          innerRightMod += distance;
          outerRightMod += distance;
        }
        innerLeftMod += innerLeft.modifier;
        innerRightMod += innerRight.modifier;
        outerLeftMod += outerLeft.modifier;
        outerRightMod += outerRight.modifier;
        if (++operations % 256 === 0) yield;
      }
      if (innerLeft && !rightContour(outerRight)) {
        outerRight.thread = innerLeft;
        outerRight.modifier += innerLeftMod - outerRightMod;
      }
      if (innerRight && !leftContour(outerLeft)) {
        outerLeft.thread = innerRight;
        outerLeft.modifier += innerRightMod - outerLeftMod;
        ancestor = layout;
      }
      return ancestor;
    }
    const stack = [{ layout: root, done: false }];
    while (stack.length) {
      const { layout, done } = stack.pop();
      if (!done) {
        stack.push({ layout, done: true });
        for (let i = layout.children.length - 1; i >= 0; i--) {
          stack.push({ layout: layout.children[i], done: false });
          if (++operations % 256 === 0) yield;
        }
        continue;
      }
      const previous = layout.index ? layout.parent.children[layout.index - 1] : null;
      if (layout.children.length) {
        let shift = 0, change = 0;
        for (let i = layout.children.length - 1; i >= 0; i--) {
          const child = layout.children[i];
          child.prelim += shift;
          child.modifier += shift;
          change += child.change;
          shift += child.shift + change;
          if (++operations % 256 === 0) yield;
        }
        const midpoint = (layout.children[0].prelim + layout.children.at(-1).prelim) / 2;
        layout.prelim = previous ? previous.prelim + COLUMN_STEP : midpoint;
        layout.modifier = layout.prelim - midpoint;
      } else if (previous) layout.prelim = previous.prelim + COLUMN_STEP;
      if (layout.parent) {
        const parent = layout.parent;
        parent.defaultAncestor = yield* pack(layout, previous, parent.defaultAncestor ?? parent.children[0]);
      }
      if (++operations % 256 === 0) yield;
    }
    let minimum = Infinity, maximum = -Infinity;
    const positions = [{ layout: root, modifier: 0 }];
    while (positions.length) {
      const { layout, modifier } = positions.pop();
      if (layout.node) {
        layout.node.x = layout.prelim + modifier;
        minimum = Math.min(minimum, layout.node.x);
        maximum = Math.max(maximum, layout.node.x);
      }
      for (const child of layout.children) {
        positions.push({ layout: child, modifier: modifier + layout.modifier });
        if (++operations % 256 === 0) yield;
      }
      if (++operations % 256 === 0) yield;
    }
    if (!Number.isFinite(minimum)) return CARD.width;
    for (const node of nodes.values()) {
      node.x -= minimum;
      if (++operations % 256 === 0) yield;
    }
    return maximum - minimum + CARD.width;
  }

  // The panel reads the same full-history state as the arrows. Internal nodes
  // remain in that state; the view connects visible messages through them.
  const graphMessageText = (message) => {
    return presentation.messageText(message, { attachments: true, citations: true }).trim() || "[Message]";
  };

  function* buildMessageGraphView(graph) {
    let operations = 0;
    const source = graph.liveMapping ?? graph.batchMapping;
    const mapping = graph.mapping;
    const nodes = new Map();
    for (const id of Object.keys(source)) {
      const node = source[id];
      const role = mapping[id]?.visibleRole;
      if (role) nodes.set(id, { id, role, text: graphMessageText(node.message), parent: null, children: [], x: 0, y: 0 });
      if (++operations % 256 === 0) yield;
    }
    const roots = [];
    const visited = new Set();
    const ordered = [];
    const childrenById = new Map();
    const ids = Object.keys(mapping), starts = [];
    for (const id of ids) {
      const node = mapping[id], children = new Set();
      for (const child of node.children) {
        if (mapping[child]?.parent === id) children.add(child);
        if (++operations % 256 === 0) yield;
      }
      childrenById.set(id, children);
      if (!node.parent || !mapping[node.parent]) starts.push(id);
      if (++operations % 256 === 0) yield;
    }
    for (const id of ids) {
      const node = mapping[id];
      if (node.parent && childrenById.has(node.parent)) childrenById.get(node.parent).add(id);
      if (++operations % 256 === 0) yield;
    }
    // A second pass includes disconnected or cyclic components without
    // recursion, without rewriting the client's parent/children links.
    for (const start of [...starts, ...ids]) {
      if (visited.has(start)) continue;
      const stack = [{ id: start, parent: null, depth: 0 }];
      while (stack.length) {
        const item = stack.pop();
        if (visited.has(item.id) || !mapping[item.id]) continue;
        visited.add(item.id);
        const visible = nodes.get(item.id);
        const parent = nodes.get(item.parent);
        if (visible) {
          visible.parent = parent?.id ?? null;
          visible.y = item.depth * ROW_STEP;
          if (parent) parent.children.push(visible.id);
          else roots.push(visible.id);
          ordered.push(visible);
        }
        const children = [...childrenById.get(item.id)];
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ id: children[i], parent: visible?.id ?? item.parent, depth: item.depth + (visible ? 1 : 0) });
          if (++operations % 256 === 0) yield;
        }
        if (++operations % 256 === 0) yield;
      }
    }
    const width = yield* layoutMessageTree(nodes, roots);
    const connections = [];
    for (const parent of ordered) {
      const children = parent.children.map((id) => nodes.get(id));
      if (!children.length) continue;
      const x = parent.x + CARD.width / 2, y = parent.y + CARD.height;
      let left = x, right = x, bottom = y, top = Infinity;
      for (const child of children) {
        left = Math.min(left, child.x + CARD.width / 2); right = Math.max(right, child.x + CARD.width / 2);
        bottom = Math.max(bottom, child.y); top = Math.min(top, child.y);
        if (++operations % 256 === 0) yield;
      }
      let d;
      if (children.length === 1) d = `M${x} ${y}V${top}`;
      else {
        const bus = (y + top) / 2, radius = Math.min(10, (top - y) / 4, (right - left) / 4);
        // One stem and rail per family. Only the outer elbows turn; the
        // intermediate children join the common rail with straight drops.
        d = `M${x} ${y}V${bus}M${left} ${bus + radius}Q${left} ${bus} ${left + radius} ${bus}H${right - radius}Q${right} ${bus} ${right} ${bus + radius}`;
        for (const child of children) {
          const cx = child.x + CARD.width / 2;
          d += `M${cx} ${cx === left || cx === right ? bus + radius : bus}V${child.y}`;
          if (++operations % 256 === 0) yield;
        }
      }
      connections.push({ parentId: parent.id, d, left, right, top: y, bottom });
      if (++operations % 256 === 0) yield;
    }
    const rows = new Map();
    for (const node of ordered) {
      const row = node.y / ROW_STEP;
      if (!rows.has(row)) rows.set(row, { nodes: [], connections: [] });
      rows.get(row).nodes.push(node);
      if (++operations % 256 === 0) yield;
    }
    for (const connection of connections) {
      rows.get(nodes.get(connection.parentId).y / ROW_STEP).connections.push(connection);
      if (++operations % 256 === 0) yield;
    }
    for (const row of rows.values()) {
      row.nodes.sort((a, b) => a.x - b.x);
      row.connections.sort((a, b) => a.left - b.left);
      if (++operations % 256 === 0) yield;
    }
    return { nodes, ordered, roots, connections, rows, width,
      height: ordered.reduce((height, node) => Math.max(height, node.y), 0) + CARD.height };
  }

  // The pure synchronous entry point is used by offline geometry checks.
  // Panel builds use the same iterator, yielding between bounded work slices.
  const createMessageGraphView = (graph) => {
    const builder = buildMessageGraphView(graph);
    let result;
    do { result = builder.next(); } while (!result.done);
    return result.value;
  };

  // One cancellable build belongs to one panel lifetime. No timer is retained
  // after completion, replacement or abort; partial models are never published.
  const createViewBuild = (graph, { signal, complete, failed }) => {
    let builder = buildMessageGraphView(graph), timer = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      builder?.return();
      builder = null;
      signal.removeEventListener("abort", cancel);
    };
    const step = () => {
      timer = null;
      if (signal.aborted || !builder) { cancel(); return; }
      try {
        const start = performance.now();
        do {
          const result = builder.next();
          if (result.done) {
            cancel();
            complete(result.value);
            return;
          }
        } while (performance.now() - start < 8);
        timer = setTimeout(step, 0);
      } catch (error) {
        cancel();
        failed(error);
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    return { start: step, cancel };
  };

  const graphViewportItems = (view, left, top, right, bottom) => {
    const nodes = [], connections = [];
    // Every family connects adjacent visible rows. Include the preceding row
    // for stems crossing the top edge. Tidy sibling contours keep each row's
    // family intervals disjoint, so both left and right endpoints are ordered.
    // Searching the right endpoint retains long rails with off-screen parents.
    const firstIntersecting = (items, end) => {
      let low = 0, high = items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (end(items[middle]) < left) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const first = Math.max(0, Math.floor(top / ROW_STEP) - 1);
    const last = Math.min(Math.floor(view.height / ROW_STEP), Math.floor(bottom / ROW_STEP));
    for (let row = first; row <= last; row++) {
      const items = view.rows.get(row);
      if (!items) continue;
      for (let i = firstIntersecting(items.nodes, (node) => node.x + CARD.width); i < items.nodes.length; i++) {
        const node = items.nodes[i];
        if (node.x > right) break;
        if (node.y + CARD.height >= top && node.y <= bottom) nodes.push(node);
      }
      for (let i = firstIntersecting(items.connections, (connection) => connection.right); i < items.connections.length; i++) {
        const connection = items.connections[i];
        if (connection.left > right) break;
        if (connection.bottom >= top && connection.top <= bottom) connections.push(connection);
      }
    }
    return { nodes, connections };
  };

  const currentBranchPaths = (view, mapping, selection) => {
    const paths = new Map();
    const ids = branch.branchPath(mapping, selection).ids.filter((id) => view.nodes.has(id));
    for (let i = 1; i < ids.length; i++) {
      const parent = view.nodes.get(ids[i - 1]), child = view.nodes.get(ids[i]);
      if (child.parent !== parent.id) continue;
      const x = parent.x + CARD.width / 2, y = parent.y + CARD.height, cx = child.x + CARD.width / 2;
      let d = `M${x} ${y}V${child.y}`;
      if (parent.children.length > 1) {
        const left = view.nodes.get(parent.children[0]).x + CARD.width / 2;
        const right = view.nodes.get(parent.children.at(-1)).x + CARD.width / 2;
        const bus = (y + child.y) / 2, radius = Math.min(10, (child.y - y) / 4, (right - left) / 4);
        d = `M${x} ${y}V${bus}`;
        if (cx === left) d += `H${left + radius}Q${left} ${bus} ${left} ${bus + radius}`;
        else if (cx === right) d += `H${right - radius}Q${right} ${bus} ${right} ${bus + radius}`;
        else d += `H${cx}`;
        d += `V${child.y}`;
      }
      paths.set(parent.id, d);
    }
    return paths;
  };

  const graphChatPage = () => {
    const hash = location.hash.toLowerCase();
    if (hash === "#settings" || hash.startsWith("#settings/") ||
        hash === "#/settings" || hash.startsWith("#/settings/")) return false;
    const parts = location.pathname.split("/").filter(Boolean);
    return (parts.length === 2 && parts[0] === "c") ||
      (parts.length === 4 && parts[0] === "g" && parts[2] === "c");
  };

  const graphElementVisible = (element) => element?.isConnected && element.getClientRects().length > 0 &&
    !element.closest('[hidden], [aria-hidden="true"], [inert]') && getComputedStyle(element).visibility !== "hidden";

  const createWorkspaceVisibilityWatch = () => {
    let observer = null, targets = new Set(), surfaces = new Map();
    const stop = () => {
      observer?.disconnect();
      observer = null;
      targets.clear();
      surfaces.clear();
    };
    const update = () => {
      const nextTargets = new Set(), nextSurfaces = new Map();
      for (const main of document.querySelectorAll("main")) {
        for (const surface of [main, ...main.querySelectorAll("header")]) {
          nextSurfaces.set(surface, graphElementVisible(surface));
          for (let element = surface; element; element = element.parentElement) nextTargets.add(element);
        }
      }
      surfaces = nextSurfaces;
      if (nextTargets.size === targets.size && [...nextTargets].every((element) => targets.has(element))) return;
      observer?.disconnect();
      targets = nextTargets;
      if (!targets.size) return;
      observer ??= new MutationObserver(() => {
        // AppShell retains hidden workspaces. Attribute-only activation can
        // change the visible main without adding messages or replacing DOM.
        // Observe container attributes only, never the message subtree.
        let changed = false;
        for (const [surface, previous] of surfaces) {
          const visible = graphElementVisible(surface);
          if (visible !== previous) { surfaces.set(surface, visible); changed = true; }
        }
        if (changed) schedule();
      });
      for (const element of targets) observer.observe(element, {
        attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden", "inert"],
      });
    };
    return { update, stop };
  };

  const activeGraphContext = () => {
    if (!graphChatPage()) return null;
    const routeId = location.pathname.match(/(?:^|\/)c\/([^/?#]+)/)?.[1];
    for (const element of document.querySelectorAll(`${USER_BUBBLE}, ${ASSISTANT_MESSAGE}`)) {
      if (!graphElementVisible(element)) continue;
      const context = readContext(element);
      if (!context || (routeId && conversationKey(context) !== routeId)) continue;
      const main = element.closest("main");
      if (main) return { ...context, element, main };
    }
    return null;
  };

  const sameGraphOwner = (left, right) => left && right &&
    conversationKey(left) === conversationKey(right) &&
    (left.scope.node ?? left.scope) === (right.scope.node ?? right.scope);

  const messageScroller = (element) => {
    const key = getFiber(element);
    for (let fiber = currentFiber(key ? element[key] : null), depth = 0; fiber && depth < 100; fiber = fiber.return, depth++) {
      for (let hook = fiber.memoizedState, index = 0; hook && index < 150; hook = hook.next, index++) {
        const handle = hook.memoizedState?.current;
        if (typeof handle?.scrollToMessage === "function") return handle;
      }
    }
    return null;
  };

  const focusNativeMessage = (element) => {
    const temporary = !element.hasAttribute("tabindex");
    const restore = () => {
      element.removeEventListener("blur", restore);
      if (element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
    };
    if (temporary) {
      element.setAttribute("tabindex", "-1");
      // Chromium blurs a focused div when its tabindex is removed. Restore on
      // blur instead; this element-owned listener retains no panel or history.
      element.addEventListener("blur", restore, { once: true });
    }
    try { element.focus({ preventScroll: true }); }
    finally { if (temporary && document.activeElement !== element) restore(); }
    return document.activeElement === element;
  };

  const focusGraphMessage = (owner, messageId, isCurrent, signal) => new Promise((resolve) => {
    let done = false, running = false, frame = null, observer = null, timeout = null;
    const attempted = new WeakSet();
    const finish = (success) => {
      if (done) return;
      done = true;
      observer?.disconnect();
      clearTimeout(timeout);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      signal?.removeEventListener("abort", cancel);
      resolve(success);
    };
    const cancel = () => finish(false);
    const attempt = async () => {
      frame = null;
      if (done || running) return;
      if (!isCurrent()) return finish(false);
      running = true;
      try {
        const active = activeGraphContext();
        if (!sameGraphOwner(owner, active)) return;
        const handle = messageScroller(active.element);
        if (handle && !attempted.has(handle)) {
          attempted.add(handle);
          await handle.scrollToMessage(messageId);
        }
        if (!isCurrent() || done) return finish(false);
        for (const element of active.main.querySelectorAll(`${USER_BUBBLE}, ${ASSISTANT_MESSAGE}`)) {
          if (!graphElementVisible(element)) continue;
          const context = readContext(element);
          if (context?.messageId !== messageId || !sameGraphOwner(owner, context)) continue;
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          if (focusNativeMessage(element)) return finish(true);
        }
      } catch {
        // A rerender can replace the native handle; the next commit retries
        // focus only, never branch selection or a busy click.
      } finally { running = false; }
    };
    const queue = () => {
      if (done || frame !== null) return;
      frame = requestAnimationFrame(() => { void attempt(); });
    };
    if (signal?.aborted || !isCurrent()) return finish(false);
    signal?.addEventListener("abort", cancel, { once: true });
    observer = new MutationObserver(queue);
    observer.observe(owner.main, { childList: true, subtree: true });
    // This timeout only bounds focus of a virtualized message. Busy state is
    // always read from native signals, never inferred from this timeout.
    timeout = setTimeout(() => finish(false), 8000);
    queue();
  });

  // The native switch may already be in flight when the panel closes. Its
  // AbortSignal cancels only our later scrolling, focus and observer lifetime.
  const navigateGraphMessage = async (owner, messageId, signal) => {
    const startedInSavedConversation = /(?:^|\/)c\/[^/?#]+/.test(location.pathname);
    const isCurrent = () => {
      const routeId = location.pathname.match(/(?:^|\/)c\/([^/?#]+)/)?.[1];
      if (signal?.aborted || !graphChatPage() || isStopped() || !owner.main.isConnected || (startedInSavedConversation && !routeId) ||
          (routeId && routeId !== conversationKey(owner))) return false;
      const current = activeGraphContext();
      return current ? sameGraphOwner(owner, current) : true;
    };
    if (!isCurrent() || conversationBusy(owner)) return false;
    const graph = graphFor(owner);
    if (!graph?.mapping[messageId] || !hydrateGraph(owner, graph)) return false;
    if (!await requestSwitch(owner, owner.messageId, messageId, owner.element, isCurrent)) return false;
    if (!isCurrent()) return false;
    return focusGraphMessage(owner, messageId, isCurrent, signal);
  };

  const graphOverviewGeometry = (view, viewport, transform) => {
    const size = 128, padding = 8;
    const ratio = Math.min((size - padding * 2) / view.width, (size - padding * 2) / view.height);
    const x = (size - view.width * ratio) / 2, y = (size - view.height * ratio) / 2;
    // Keep the readable themed marker requested by the user. Its display
    // footprint also responds to zoom when the literal viewport is subpixel.
    const minimum = 25 * Math.sqrt(0.8 / transform.scale);
    const width = Math.min(size, Math.max(minimum, viewport.width / transform.scale * ratio));
    const height = Math.min(size, Math.max(minimum, viewport.height / transform.scale * ratio));
    const centreX = x + (viewport.width / 2 - transform.offsetX) / transform.scale * ratio;
    const centreY = y + (viewport.height / 2 - transform.offsetY) / transform.scale * ratio;
    return { size, ratio, x, y, frame: {
      x: Math.max(0, Math.min(size - width, centreX - width / 2)),
      y: Math.max(0, Math.min(size - height, centreY - height / 2)), width, height,
    } };
  };

  const graphOverviewNodeRect = (node, geometry) => ({
    x: geometry.x + node.x * geometry.ratio, y: geometry.y + node.y * geometry.ratio,
    width: Math.max(0.8, CARD.width * geometry.ratio), height: Math.max(0.8, CARD.height * geometry.ratio),
  });

  const graphOverviewTarget = (view, geometry, point) => {
    let nearest = null, distance = 8 * 8, centreDistance = Infinity;
    // Hit-test the same rectangles that are drawn, in overview pixels. A
    // near miss snaps to the message centre; deliberate empty space stays free.
    for (const node of view.ordered) {
      const rect = graphOverviewNodeRect(node, geometry);
      const dx = Math.max(rect.x - point.x, point.x - rect.x - rect.width, 0);
      const dy = Math.max(rect.y - point.y, point.y - rect.y - rect.height, 0);
      const squared = dx * dx + dy * dy;
      const centre = (geometry.x + (node.x + CARD.width / 2) * geometry.ratio - point.x) ** 2 +
        (geometry.y + (node.y + CARD.height / 2) * geometry.ratio - point.y) ** 2;
      if (squared < distance || (squared === distance && centre < centreDistance)) {
        nearest = node.id; distance = squared; centreDistance = centre;
      }
    }
    return nearest;
  };

  const createConversationGraph = () => {
    const workspaceVisibility = createWorkspaceVisibilityWatch();
    const descriptors = {
      show: ["app.sidebar.show", "Show sidebar"], hide: ["app.sidebar.hide", "Hide sidebar"],
      search: ["browserPluginSettings.search", "Search"],
      zoomIn: ["browserSidebar.zoomBanner.zoomIn", "Zoom in"], zoomOut: ["browserSidebar.zoomBanner.zoomOut", "Zoom out"],
      fit: ["artifactTab.preview.zoomToFit", "Zoom to fit"],
      more: ["annotationCommentEditor.metadata.showMore", "Show more"],
      less: ["annotationCommentEditor.metadata.showLess", "Show less"],
      noResults: ["settings.search.noResults", "No results"],
      close: ["common.close", "Close"],
    };
    let panel = null, toggle = null, host = null, owner = null, view = null, source = null, ownerId = null;
    let dock = null, nativeHeader = null, toggleSlot = null, toolbar = null, exportControls = null;
    let viewport, canvas, cards, lines, search, results, detail, detailText, detailGrip, detailActions, expand, go, status, zoomLabel, grip;
    let overview, overviewEdges, overviewBranch, overviewUsers, overviewAnswers, overviewFrame, overviewView = null;
    let branchState = null, overviewBranchState = null;
    let open = false, width = 440, scale = 0.8, offsetX = 0, offsetY = 0, selected = null, expanded = false;
    let paintFrame = null, resizeObserver = null, interaction = null, navigating = false, resultLimit = 100;
    let detailHeight = null, typographyObserver = null;
    let searchQuery = "", closedLabelKey = null, lastPage = location.pathname + location.hash;
    let searchResultsOpen = false;
    let panelLifetime = null, viewBuild = null, statusKind = null;
    let renderedView = null;
    const renderedCards = new Map(), renderedEdges = new Map();
    const renderedBranchEdges = new Map();
    const boundLabels = [];
    const viewportControls = [];
    const text = (key) => {
      const descriptor = descriptors[key];
      return descriptor && owner ? clientText(owner.element, { id: descriptor[0], defaultMessage: descriptor[1] })
        : descriptor?.[1] ?? key;
    };
    const label = (element, value, content = false) => {
      if (content) { if (element.textContent !== value) element.textContent = value; }
      else {
        if (element.getAttribute("aria-label") !== value) element.setAttribute("aria-label", value);
        if (element.title !== value) element.title = value;
      }
    };
    const make = (tag, className, parent) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      parent?.append(element);
      return element;
    };
    const button = (parent, key, glyph, action) => {
      const element = make("button", "version-graph-button", parent);
      element.type = "button";
      if (glyph) { const icon = make("span", "", element); icon.textContent = glyph; icon.setAttribute("aria-hidden", "true"); }
      element.addEventListener("click", action);
      boundLabels.push({ element, key, content: !glyph });
      return element;
    };
    const currentOwner = () => sameGraphOwner(owner, activeGraphContext());
    const setStatus = (kind, message = "") => {
      statusKind = kind;
      if (status) status.textContent = message;
    };
    const viewportSize = () => ({ width: viewport.clientWidth, height: viewport.clientHeight });
    const centreNode = (id) => {
      const node = view?.nodes.get(id);
      if (!node) return;
      const size = viewportSize();
      offsetX = size.width / 2 - (node.x + CARD.width / 2) * scale;
      offsetY = size.height / 2 - (node.y + CARD.height / 2) * scale;
      requestPaint();
    };
    const zoom = (value, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) => {
      if (!view) return;
      const next = Math.min(2.5, Math.max(0.05, value));
      offsetX = x - (x - offsetX) * next / scale;
      offsetY = y - (y - offsetY) * next / scale;
      scale = next;
      requestPaint();
    };
    const fit = () => {
      if (!view) return;
      const size = viewportSize();
      scale = Math.min(1, Math.max(0.05, Math.min((size.width - 48) / view.width, (size.height - 48) / view.height)));
      offsetX = (size.width - view.width * scale) / 2;
      offsetY = (size.height - view.height * scale) / 2;
      requestPaint();
    };
    const renderDetail = () => {
      const node = view?.nodes.get(selected);
      detail.hidden = !node;
      if (!node) { detailText.replaceChildren(); return; }
      if (detailText.textContent !== node.text) detailText.textContent = node.text;
      detailText.classList.toggle("is-expanded", expanded);
      expand.setAttribute("aria-expanded", String(expanded));
      label(expand, text(expanded ? "less" : "more"), true);
      syncDetailTypography(); applyDetailHeight();
    };
    const syncDetailTypography = () => {
      if (!owner || !detailText || !view?.nodes.has(selected)) return;
      const selector = view.nodes.get(selected).role === "user" ? USER_BUBBLE : ASSISTANT_MESSAGE;
      const message = [...owner.main.querySelectorAll(selector)].find(graphElementVisible) ?? owner.element;
      const content = message.querySelector('[class*="MarkdownRoot-"], .markdown, .prose') ?? message;
      const style = getComputedStyle(content);
      for (const property of ["fontFamily", "fontSize", "lineHeight", "letterSpacing"]) {
        if (detailText.style[property] !== style[property]) detailText.style[property] = style[property];
      }
    };
    const detailLimits = () => {
      const style = getComputedStyle(detailText);
      const line = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 13) * 1.5;
      const available = Math.max(0, panel.clientHeight - (toolbar.offsetHeight || 52) -
        (results.hidden ? 0 : results.offsetHeight) - status.offsetHeight);
      const maximum = Math.max(0, available - 80);
      const minimum = Math.min(maximum, Math.ceil(line * 3 + 8 + (detailActions.offsetHeight || 50) + 8 + 1));
      return { line, minimum, maximum, expanded: Math.max(minimum, Math.min(maximum, available / 2)) };
    };
    const applyDetailHeight = () => {
      if (!detail || detail.hidden || !panel) return;
      const limits = detailLimits();
      const height = Math.max(limits.minimum, Math.min(limits.maximum, detailHeight ?? (expanded ? limits.expanded : limits.minimum)));
      if (detailHeight !== null) detailHeight = height;
      if (detail.style.height !== `${height}px`) detail.style.height = `${height}px`;
      for (const [name, value] of Object.entries({ now: height, min: limits.minimum, max: limits.maximum })) {
        detailGrip.setAttribute(`aria-value${name}`, String(Math.round(value)));
      }
    };
    const resizeDetail = (height) => {
      expanded = true; detailHeight = height; renderDetail(); requestPaint();
    };
    const select = (id, centre = false) => {
      selected = id;
      expanded = detailHeight !== null;
      renderDetail();
      if (centre) centreNode(id);
      else requestPaint();
    };
    const clearSelection = (restoreFocus = false) => {
      const previous = selected;
      selected = null;
      expanded = false;
      renderDetail(); requestPaint();
      if (restoreFocus) (renderedCards.get(previous) ?? viewport).focus({ preventScroll: true });
    };
    const syncCurrentBranch = (graph) => {
      if (!view) return;
      const selection = branch.readSelection(owner, api), previous = branchState?.selection;
      const sameSelection = selection?.leaf === previous?.leaf && selection?.ids.length === previous?.ids.length &&
        (selection?.ids.every((id, index) => id === previous.ids[index]) ?? true);
      if (branchState?.view === view && branchState.mapping === graph.mapping && sameSelection) return;
      branchState = { view, mapping: graph.mapping, selection, paths: currentBranchPaths(view, graph.mapping, selection) };
      requestPaint();
    };
    const dismissSearch = () => {
      searchResultsOpen = false;
      if (results) results.hidden = true;
      document.removeEventListener("pointerdown", outsideSearch, true);
      applyDetailHeight(); requestPaint();
    };
    const outsideSearch = (event) => {
      if (!search.parentElement.contains(event.target) && !results.contains(event.target)) dismissSearch();
    };
    const highlightSnippet = (element, snippet, pattern) => {
      let cursor = 0;
      for (const match of snippet.matchAll(pattern)) {
        element.append(document.createTextNode(snippet.slice(cursor, match.index).replace(/\s+/g, " ")));
        const mark = make("mark", "version-graph-search-match", element);
        mark.textContent = match[0].replace(/\s+/g, " ");
        cursor = match.index + match[0].length;
      }
      element.append(document.createTextNode(snippet.slice(cursor).replace(/\s+/g, " ")));
    };
    const renderSearch = () => {
      const query = search.value.trim();
      results.hidden = !query || !searchResultsOpen;
      results.replaceChildren();
      if (results.hidden || !view) {
        document.removeEventListener("pointerdown", outsideSearch, true);
        return;
      }
      document.addEventListener("pointerdown", outsideSearch, true);
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      let matches = 0;
      for (const node of view.ordered) {
        pattern.lastIndex = 0;
        const match = pattern.exec(node.text);
        if (!match || ++matches > resultLimit) continue;
        const result = make("button", "version-graph-result", results);
        result.type = "button";
        const snippet = node.text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 140);
        pattern.lastIndex = 0;
        highlightSnippet(result, snippet, pattern);
        result.addEventListener("click", () => { dismissSearch(); select(node.id, true); });
      }
      if (!matches) { const empty = make("p", "version-graph-empty", results); empty.textContent = text("noResults"); }
      if (matches > resultLimit) {
        const more = make("button", "version-graph-button", results);
        more.type = "button"; more.textContent = text("more");
        more.addEventListener("click", () => { resultLimit += 100; renderSearch(); });
      }
    };
    const clearOverview = () => {
      overviewView = null;
      overviewBranchState = null;
      if (overview) overview.hidden = true;
      for (const path of [overviewEdges, overviewBranch, overviewUsers, overviewAnswers]) path?.removeAttribute("d");
    };
    const renderOverview = (size) => {
      if (!view.nodes.size) { clearOverview(); return; }
      overview.hidden = false;
      const geometry = graphOverviewGeometry(view, size, { scale, offsetX, offsetY });
      if (overviewView !== view) {
        const users = [], answers = [];
        const number = (value) => value.toFixed(2);
        for (const node of view.ordered) {
          const rect = graphOverviewNodeRect(node, geometry);
          (node.role === "user" ? users : answers).push(
            `M${number(rect.x)} ${number(rect.y)}h${number(rect.width)}v${number(rect.height)}h-${number(rect.width)}Z`,
          );
        }
        overviewEdges.setAttribute("d", view.connections.map((connection) => connection.d).join(""));
        overviewEdges.setAttribute("transform", `translate(${geometry.x} ${geometry.y}) scale(${geometry.ratio})`);
        overviewUsers.setAttribute("d", users.join(""));
        overviewAnswers.setAttribute("d", answers.join(""));
        overviewView = view;
      }
      if (overviewBranchState !== branchState) {
        overviewBranch.setAttribute("d", [...(branchState?.paths.values() ?? [])].join(""));
        overviewBranch.setAttribute("transform", overviewEdges.getAttribute("transform"));
        overviewBranchState = branchState;
      }
      for (const [key, value] of Object.entries(geometry.frame)) overviewFrame.setAttribute(key, String(value));
    };
    const paint = () => {
      paintFrame = null;
      if (!open || !view) return;
      const size = viewportSize();
      const left = -offsetX / scale - 300, top = -offsetY / scale - 200;
      const right = left + size.width / scale + 600, bottom = top + size.height / scale + 400;
      canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
      canvas.style.setProperty("--version-graph-scale", String(scale));
      const percent = `${Math.round(scale * 100)}%`;
      if (zoomLabel.textContent !== percent) zoomLabel.textContent = percent;
      // Clip lines in a viewport-sized SVG instead of letting a transformed,
      // overflow-visible SVG grow to the dimensions of the entire tree.
      lines.setAttribute("viewBox", `${-offsetX / scale} ${-offsetY / scale} ${size.width / scale} ${size.height / scale}`);
      const focusedId = cards.contains(document.activeElement) ? document.activeElement.dataset.graphMessageId : null;
      if (renderedView !== view) {
        renderedCards.clear(); renderedEdges.clear(); renderedBranchEdges.clear(); cards.replaceChildren(); lines.replaceChildren();
        renderedView = view;
      }
      const visible = graphViewportItems(view, left, top, right, bottom);
      const cardIds = new Set(), edgeIds = new Set();
      for (const node of visible.nodes) {
        cardIds.add(node.id);
        let card = renderedCards.get(node.id);
        if (!card) {
          card = make("button", `version-graph-card ${node.role === "user" ? "bg-user-message text-user-message" : "text-default"}`, cards);
          card.type = "button";
          card.dataset.graphMessageId = node.id;
          card.dataset.role = node.role;
          card.style.transform = `translate(${node.x}px, ${node.y}px)`;
          make("span", "version-graph-preview", card).textContent = node.text.slice(0, 500).replace(/\s+/g, " ");
          renderedCards.set(node.id, card);
        }
        card.classList.toggle("is-selected", node.id === selected);
        const pressed = String(node.id === selected);
        if (card.getAttribute("aria-pressed") !== pressed) card.setAttribute("aria-pressed", pressed);
      }
      for (const connection of visible.connections) {
        edgeIds.add(connection.parentId);
        if (!renderedEdges.has(connection.parentId)) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.dataset.graphParentId = connection.parentId;
          path.setAttribute("d", connection.d);
          lines.append(path); renderedEdges.set(connection.parentId, path);
        }
        const d = branchState?.paths.get(connection.parentId);
        if (d) {
          let path = renderedBranchEdges.get(connection.parentId);
          if (!path) {
            path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.classList.add("is-current-branch"); path.dataset.graphBranchParentId = connection.parentId;
            lines.append(path); renderedBranchEdges.set(connection.parentId, path);
          }
          if (path.getAttribute("d") !== d) path.setAttribute("d", d);
        }
      }
      for (const [id, card] of renderedCards) if (!cardIds.has(id)) { card.remove(); renderedCards.delete(id); }
      for (const [id, path] of renderedEdges) if (!edgeIds.has(id)) { path.remove(); renderedEdges.delete(id); }
      for (const [id, path] of renderedBranchEdges) if (!edgeIds.has(id) || !branchState?.paths.has(id)) {
        path.remove(); renderedBranchEdges.delete(id);
      }
      if (focusedId && document.activeElement.dataset?.graphMessageId !== focusedId) renderedCards.get(focusedId)?.focus({ preventScroll: true });
      renderOverview(size);
    };
    function requestPaint() {
      if (open && view && paintFrame === null) paintFrame = requestAnimationFrame(paint);
    }
    const releaseView = () => {
      viewBuild?.cancel();
      viewBuild = null;
      dismissSearch();
      if (paintFrame !== null) cancelAnimationFrame(paintFrame);
      paintFrame = null;
      source = view = renderedView = null;
      branchState = null;
      renderedCards.clear(); renderedEdges.clear(); renderedBranchEdges.clear(); clearOverview();
      cards?.replaceChildren(); lines?.replaceChildren(); lines?.removeAttribute("viewBox");
      results?.replaceChildren(); detailText?.replaceChildren();
      if (results) results.hidden = true;
      if (detail) detail.hidden = true;
      setStatus(null);
      canvas?.style.removeProperty("transform");
      pointerUp();
      for (const control of viewportControls) control.disabled = true;
    };
    const availableWidth = () => (host?.clientWidth || 0) + (dock?.clientWidth || 0) || innerWidth;
    const clampWidth = (value) => {
      const available = availableWidth(), maximum = available - Math.min(260, available / 2);
      return Math.max(Math.min(240, maximum), Math.min(value, maximum));
    };
    const placeToggle = () => {
      if (!toggle || !toggleSlot) return;
      const surface = nativeHeader.querySelector('[data-testid="app-shell-header-context-menu-surface"]');
      let trailing = surface?.nextElementSibling;
      if (trailing === toggleSlot) trailing = trailing.nextElementSibling;
      const viewer = [...host.querySelectorAll('[data-testid="viewer-header"]')].find(graphElementVisible);
      // AppShell reserves the viewer's width in the trailing titlebar cell.
      // Keep our slot on the chat side of that cell, away from viewer actions.
      const before = viewer && trailing?.parentElement === nativeHeader ? trailing : null;
      if (before) {
        if (toggleSlot.nextElementSibling !== before) nativeHeader.insertBefore(toggleSlot, before);
      } else if (nativeHeader.lastElementChild !== toggleSlot) nativeHeader.append(toggleSlot);
      const parent = open && toolbar ? toolbar : toggleSlot;
      if (toggle.parentElement !== parent) open ? parent.prepend(toggle) : parent.append(toggle);
      toggleSlot.hidden = open || !graphChatPage();
    };
    const applyWidth = () => {
      width = clampWidth(width);
      dock?.style.setProperty("--version-graph-width", `${width}px`);
      nativeHeader?.style.setProperty("--version-graph-header-reserve", open ? `${width}px` : "0px");
      grip?.setAttribute("aria-valuenow", String(Math.round(width)));
      grip?.setAttribute("aria-valuemin", String(Math.round(Math.min(240, width))));
      grip?.setAttribute("aria-valuemax", String(Math.round(clampWidth(Infinity))));
    };
    const resetConversationView = () => {
      selected = ownerId = null;
      detailHeight = null;
      expanded = false;
      searchQuery = "";
      searchResultsOpen = false;
      resultLimit = 100;
      scale = 0.8;
      offsetX = offsetY = 0;
    };
    const setOpen = (value) => {
      open = value;
      if (!open) { destroyPanel(); owner = null; closedLabelKey = null; }
      dock?.toggleAttribute("data-version-graph-open", open);
      placeToggle();
      panel?.setAttribute("aria-hidden", String(!open));
      if (panel) panel.inert = !open;
      toggle?.setAttribute("aria-expanded", String(open));
      if (toggle) label(toggle, text(open ? "hide" : "show"));
      reconcile();
    };
    // The panel uses border-box sizing. Its computed size is local CSS space;
    // its screen rectangle includes ancestor CSS zoom. Freeze the conversion
    // at gesture start so moving the panel edge cannot change the drag origin.
    const clientUnits = () => {
      const rect = panel.getBoundingClientRect(), style = getComputedStyle(panel);
      const x = parseFloat(style.width) / rect.width, y = parseFloat(style.height) / rect.height;
      return { x: Number.isFinite(x) && x > 0 ? x : 1, y: Number.isFinite(y) && y > 0 ? y : 1 };
    };
    const beginInteraction = (event, mode) => {
      if (event.button !== 0 || interaction) return;
      interaction = { mode, pointerId: event.pointerId, capture: event.currentTarget, units: clientUnits(),
        x: event.clientX, y: event.clientY, offsetX, offsetY, width, height: parseFloat(detail?.style.height) || 0 };
      interaction.capture.setPointerCapture?.(event.pointerId);
      if (mode === "pan") viewport.classList.add("is-dragging");
      event.preventDefault();
    };
    const pointerDown = (event) => {
      if (!view || event.target.closest("button,input,textarea")) return;
      beginInteraction(event, "pan");
    };
    const pointerMove = (event) => {
      if (!interaction || event.pointerId !== interaction.pointerId) return;
      if (!(event.buttons & 1)) { pointerUp(); return; }
      const dx = (event.clientX - interaction.x) * interaction.units.x;
      const dy = (event.clientY - interaction.y) * interaction.units.y;
      if (interaction.mode === "resize") {
        width = interaction.width - dx;
        applyWidth();
      } else if (interaction.mode === "detail-resize") {
        resizeDetail(interaction.height - dy);
      } else {
        offsetX = interaction.offsetX + dx;
        offsetY = interaction.offsetY + dy;
        requestPaint();
      }
    };
    const pointerUp = (event) => {
      if (!interaction || (event && event.pointerId !== interaction.pointerId)) return;
      const { capture, pointerId } = interaction;
      interaction = null;
      viewport?.classList.remove("is-dragging");
      if (capture.hasPointerCapture?.(pointerId)) capture.releasePointerCapture(pointerId);
    };
    const cancelInteraction = () => pointerUp();
    const mountTrigger = (context) => {
      const main = context?.main;
      if (!graphElementVisible(main)) return false;
      const header = [...main.querySelectorAll("header")].find(graphElementVisible);
      if (!header || !main.parentElement) return false;
      host = main; nativeHeader = header;
      nativeHeader.setAttribute("data-version-graph-header", "");
      toggleSlot = make("div", "version-graph-toggle-slot", header);
      toggleSlot.dataset.versionGraphToggleSlot = "";
      const reference = document.querySelector("button[data-app-shell-sidebar-trigger]");
      toggle = reference ? reference.cloneNode(false) : make("button");
      const styleAttributes = new Set(["class", "data-color", "data-variant", "data-uniform", "data-size", "data-icon-size", "data-suppress-active-style"]);
      for (const name of toggle.getAttributeNames()) if (!styleAttributes.has(name)) toggle.removeAttribute(name);
      toggle.classList.remove("group/sidebar-trigger", "cursor-e-resize", "cursor-w-resize", "rtl:cursor-w-resize", "rtl:cursor-e-resize");
      toggle.dataset.versionGraphToggle = "";
      toggle.type = "button";
      toggle.setAttribute("aria-controls", "version-arrows-graph");
      toggle.setAttribute("aria-expanded", "false");
      if (!reference) toggle.className = "version-graph-button";
      // The native collapsed trigger contains a brand and hover-only symbols.
      // Keep its button styling, but use one permanent sidebar-light-20 shape.
      const sidebarIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [name, value] of Object.entries({ viewBox: "0 0 20 20", width: "20", height: "20",
        fill: "currentColor", "fill-rule": "evenodd", "clip-rule": "evenodd", "aria-hidden": "true", focusable: "false",
        class: "version-graph-sidebar-icon" })) sidebarIcon.setAttribute(name, value);
      const sidebarPath = document.createElementNS(sidebarIcon.namespaceURI, "path");
      sidebarPath.setAttribute("d", "M14.5 2.877a3.665 3.665 0 0 1 3.665 3.665v6.917a3.665 3.665 0 0 1-3.665 3.665h-9a3.665 3.665 0 0 1-3.665-3.665V6.542A3.665 3.665 0 0 1 5.5 2.877zM8.165 15.794H14.5a2.335 2.335 0 0 0 2.335-2.335V6.542A2.335 2.335 0 0 0 14.5 4.207H8.165zM5.5 4.207a2.335 2.335 0 0 0-2.335 2.335v6.917A2.335 2.335 0 0 0 5.5 15.794h1.335V4.207z");
      sidebarIcon.append(sidebarPath);
      toggle.append(sidebarIcon);
      toggle.addEventListener("click", () => {
        if (graphChatPage() && (open || activeGraphContext())) setOpen(!open);
      });
      toggleSlot.append(toggle);
      return true;
    };
    const mountPanel = () => {
      panelLifetime = new AbortController();
      host.setAttribute("data-version-graph-host", "");
      dock = make("div", "version-graph-dock"); dock.dataset.versionGraph = "";
      host.after(dock);
      panel = make("aside", "version-graph", dock);
      panel.id = "version-arrows-graph";
      panel.dataset.versionGraph = "";
      panel.style.setProperty("--version-graph-card-width", `${CARD.width}px`);
      panel.style.setProperty("--version-graph-card-height", `${CARD.height}px`);
      panel.setAttribute("aria-label", "Conversation graph");
      panel.setAttribute("aria-hidden", "true"); panel.inert = true;
      toolbar = make("div", "version-graph-toolbar", panel);
      const searchRow = make("div", "version-graph-search", toolbar);
      search = make("input", "", searchRow); search.type = "search";
      search.value = searchQuery;
      search.addEventListener("input", () => {
        searchQuery = search.value; resultLimit = 100; searchResultsOpen = true; renderSearch();
      });
      const reopenSearch = () => { if (!searchResultsOpen) { searchResultsOpen = true; renderSearch(); } };
      search.addEventListener("focus", reopenSearch);
      search.addEventListener("click", reopenSearch);
      search.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !results.hidden) {
          dismissSearch(); event.preventDefault(); event.stopPropagation();
        }
      });
      results = make("div", "version-graph-results", panel); results.hidden = true;
      viewport = make("div", "version-graph-viewport", panel);
      viewport.setAttribute("aria-label", "Conversation graph");
      viewport.tabIndex = 0;
      lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      lines.setAttribute("aria-hidden", "true"); lines.classList.add("version-graph-lines"); viewport.append(lines);
      canvas = make("div", "version-graph-canvas", viewport);
      cards = make("div", "version-graph-cards", canvas);
      cards.addEventListener("click", (event) => {
        const card = event.target.closest("[data-graph-message-id]");
        if (card && cards.contains(card)) {
          if (selected === card.dataset.graphMessageId) clearSelection();
          else select(card.dataset.graphMessageId);
        }
      });
      overview = make("button", "version-graph-overview", viewport); overview.type = "button";
      overview.hidden = true;
      overview.setAttribute("aria-label", "Graph overview");
      overview.addEventListener("click", (event) => {
        if (!view) return;
        const size = viewportSize(), geometry = graphOverviewGeometry(view, size, { scale, offsetX, offsetY });
        // The SVG excludes the button border; use its actual drawing surface
        // for both hit-testing and conversion back to graph coordinates.
        const rect = overview.firstElementChild.getBoundingClientRect();
        if (event.detail === 0 && event.clientX === 0 && event.clientY === 0) {
          centreNode(view.nodes.has(selected) ? selected : view.roots[0]); return;
        }
        if (!rect.width || !rect.height) return;
        const point = { x: (event.clientX - rect.left) / rect.width * geometry.size,
          y: (event.clientY - rect.top) / rect.height * geometry.size };
        const target = graphOverviewTarget(view, geometry, point);
        if (target) { centreNode(target); return; }
        const x = Math.max(0, Math.min(view.width, (point.x - geometry.x) / geometry.ratio));
        const y = Math.max(0, Math.min(view.height, (point.y - geometry.y) / geometry.ratio));
        offsetX = size.width / 2 - x * scale; offsetY = size.height / 2 - y * scale;
        requestPaint();
      });
      const overviewSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      overviewSvg.setAttribute("viewBox", "0 0 128 128"); overviewSvg.setAttribute("aria-hidden", "true");
      overview.append(overviewSvg);
      const overviewElement = (tag, className) => {
        const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
        element.setAttribute("class", className); overviewSvg.append(element); return element;
      };
      overviewEdges = overviewElement("path", "version-graph-overview-edges");
      overviewBranch = overviewElement("path", "version-graph-overview-branch");
      overviewUsers = overviewElement("path", "version-graph-overview-users");
      overviewAnswers = overviewElement("path", "version-graph-overview-answers");
      overviewFrame = overviewElement("rect", "version-graph-overview-frame");
      const tools = make("div", "version-graph-tools", toolbar);
      viewportControls.push(button(tools, "zoomOut", "−", () => zoom(scale / 1.2)));
      zoomLabel = make("span", "version-graph-zoom", tools);
      viewportControls.push(button(tools, "zoomIn", "+", () => zoom(scale * 1.2)));
      viewportControls.push(button(tools, "fit", "⛶", fit));
      for (const control of viewportControls) control.disabled = !view;
      dispatchEvent(new CustomEvent("chatgpt-version-arrows:export-connect", { detail: (create) => {
        if (exportControls) return;
        exportControls = create({ parent: toolbar, api, read: () => {
          const context = activeGraphContext();
          if (!open || !sameGraphOwner(owner, context) || conversationBusy(context)) throw new Error("Conversation unavailable");
          return { context, conversationId: conversationKey(context), graph: graphFor(context), title: document.title };
        } });
      } }));
      detail = make("div", "version-graph-detail", panel); detail.hidden = true;
      detailGrip = make("div", "version-graph-detail-resize", detail); detailGrip.tabIndex = 0;
      detailGrip.setAttribute("role", "separator"); detailGrip.setAttribute("aria-orientation", "horizontal");
      detailGrip.setAttribute("aria-label", "Resize message");
      detailGrip.addEventListener("pointerdown", (event) => beginInteraction(event, "detail-resize"));
      detailGrip.addEventListener("keydown", (event) => {
        if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
        resizeDetail(parseFloat(detail.style.height) + (event.key === "ArrowUp" ? 1 : -1) * detailLimits().line);
        event.preventDefault();
      });
      detailText = make("div", "version-graph-detail-text", detail);
      detailActions = make("div", "version-graph-actions", detail);
      const closePreview = button(detail, "close", "×", () => clearSelection(true));
      closePreview.classList.add("version-graph-detail-close");
      // Native xmark-md-light-16 geometry, independent of the text baseline.
      const closeIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", fill: "currentColor",
        "aria-hidden": "true", focusable: "false", class: "version-graph-close-icon" })) closeIcon.setAttribute(name, value);
      const closePath = document.createElementNS(closeIcon.namespaceURI, "path");
      closePath.setAttribute("d", "M10.962 4.295a.525.525 0 0 1 .742.743L8.742 7.999l2.963 2.963a.526.526 0 0 1-.742.743L8 8.742l-2.963 2.963a.525.525 0 0 1-.742-.743L7.258 8 4.296 5.038a.525.525 0 1 1 .742-.743L8 7.257z");
      closeIcon.append(closePath); closePreview.replaceChildren(closeIcon);
      expand = button(detailActions, "more", null, () => { expanded = !expanded; detailHeight = null; renderDetail(); requestPaint(); });
      go = make("button", "version-graph-button version-graph-go", detailActions); go.type = "button"; go.textContent = "Go to message";
      go.addEventListener("click", async () => {
        if (!selected || !owner || navigating || !currentOwner() || conversationBusy(owner)) return;
        const requestedOwner = owner, requestedId = selected;
        const lifetime = panelLifetime;
        navigating = true;
        go.disabled = true;
        setStatus(null);
        try {
          const success = await navigateGraphMessage(requestedOwner, requestedId, lifetime.signal);
          if (!lifetime.signal.aborted && panelLifetime === lifetime && !success) {
            setStatus("error", "Unable to open this message. Try again.");
          }
        } finally {
          if (!lifetime.signal.aborted && panelLifetime === lifetime) {
            navigating = false;
            schedule();
          }
        }
      });
      status = make("p", "version-graph-status", panel); status.setAttribute("role", "status");
      grip = make("div", "version-graph-resize", panel);
      grip.setAttribute("role", "separator"); grip.setAttribute("aria-orientation", "vertical");
      grip.setAttribute("aria-label", "Resize sidebar"); grip.setAttribute("aria-valuemin", "240"); grip.tabIndex = 0;
      grip.addEventListener("pointerdown", (event) => beginInteraction(event, "resize"));
      grip.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        width += event.key === "ArrowLeft" ? 24 : -24; applyWidth(); event.preventDefault();
      });
      viewport.addEventListener("pointerdown", pointerDown);
      panel.addEventListener("pointermove", pointerMove);
      panel.addEventListener("pointerup", pointerUp);
      panel.addEventListener("pointercancel", pointerUp);
      panel.addEventListener("lostpointercapture", pointerUp);
      addEventListener("blur", cancelInteraction);
      viewport.addEventListener("wheel", (event) => {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const units = clientUnits();
        zoom(scale * Math.exp(-event.deltaY * 0.002), (event.clientX - rect.left) * units.x, (event.clientY - rect.top) * units.y);
      }, { passive: false });
      viewport.addEventListener("keydown", (event) => {
        if (event.target !== viewport || !view) return;
        if (event.key === "+" || event.key === "=") zoom(scale * 1.2);
        else if (event.key === "-") zoom(scale / 1.2);
        else if (event.key === "0") fit();
        else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          offsetX += event.key === "ArrowLeft" ? 48 : event.key === "ArrowRight" ? -48 : 0;
          offsetY += event.key === "ArrowUp" ? 48 : event.key === "ArrowDown" ? -48 : 0;
          requestPaint();
        } else return;
        event.preventDefault();
      });
      panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { setOpen(false); toggle.focus(); event.stopPropagation(); } });
      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(() => { applyWidth(); applyDetailHeight(); requestPaint(); });
        resizeObserver.observe(host); resizeObserver.observe(viewport);
      }
      typographyObserver = new MutationObserver((mutations) => {
        if (!open || !selected) return;
        if (mutations.some(({ target }) => !target.closest?.("[data-version-graph], [data-version-graph-header]") &&
            (target === document.documentElement || target === document.body || target.contains(owner?.element) ||
             target.closest?.(`${USER_BUBBLE}, ${ASSISTANT_MESSAGE}`)))) schedule();
      });
      const typographyAttributes = { attributes: true, attributeFilter: ["class", "style", "data-theme"] };
      typographyObserver.observe(document.documentElement, typographyAttributes);
      if (document.body) typographyObserver.observe(document.body, typographyAttributes);
      typographyObserver.observe(host, { ...typographyAttributes, subtree: true });
      addEventListener("resize", onResize);
      applyWidth();
    };
    const destroyPanel = () => {
      panelLifetime?.abort();
      panelLifetime = null;
      navigating = false;
      exportControls?.dispose(); exportControls = null;
      // Keep only the trigger and small scalar preferences while closed.
      // No model, detached message DOM, panel observer or render frame survives.
      if (toggle && toggleSlot && toggle.parentElement !== toggleSlot) toggleSlot.append(toggle);
      releaseView();
      removeEventListener("resize", onResize);
      removeEventListener("blur", cancelInteraction);
      resizeObserver?.disconnect(); resizeObserver = null;
      typographyObserver?.disconnect(); typographyObserver = null;
      dock?.remove();
      host?.removeAttribute("data-version-graph-host");
      if (nativeHeader?.style.getPropertyValue("--version-graph-header-reserve")) nativeHeader.style.setProperty("--version-graph-header-reserve", "0px");
      dock = toolbar = panel = null;
      viewport = canvas = cards = lines = search = results = detail = detailText = null;
      detailGrip = detailActions = expand = go = status = zoomLabel = grip = null;
      overview = overviewEdges = overviewBranch = overviewUsers = overviewAnswers = overviewFrame = null;
      boundLabels.length = 0; interaction = null;
      viewportControls.length = 0;
    };
    const unmount = () => {
      destroyPanel();
      toggle?.remove(); toggleSlot?.remove();
      nativeHeader?.removeAttribute("data-version-graph-header");
      nativeHeader?.style.removeProperty("--version-graph-header-reserve");
      nativeHeader = toggleSlot = toggle = host = owner = null; closedLabelKey = null;
    };
    function reconcile() {
      if (!isShell()) { workspaceVisibility.stop(); unmount(); return; }
      const chatPage = graphChatPage(), page = location.pathname + location.hash;
      const pageChanged = page !== lastPage;
      const pathChanged = location.pathname !== lastPage.split("#")[0];
      // Close before reading a new owner's history, including the interval
      // when the previous transcript is still mounted during navigation.
      lastPage = page;
      if (!chatPage) {
        workspaceVisibility.stop();
        resetConversationView();
        open = false;
        unmount();
        return;
      }
      workspaceVisibility.update();
      if (pageChanged && (!open || pathChanged)) {
        resetConversationView();
        if (open) { setOpen(false); return; }
      }
      const context = activeGraphContext();
      // A titlebar or chat-shaped URL alone is not a loaded conversation.
      // Keep no launcher for loading/retained-background messages of another owner.
      if (!context && !open) { unmount(); return; }
      const workspaceChanged = host && (!graphElementVisible(host) || (context && context.main !== host));
      if (workspaceChanged && open) {
        resetConversationView();
        open = false;
      }
      if (toggle && (workspaceChanged || !toggle.isConnected || !nativeHeader.isConnected || !graphElementVisible(nativeHeader) ||
          (dock && dock.parentElement !== host.parentElement))) unmount();
      if (!toggle && !mountTrigger(context)) return;
      toggle.disabled = false;
      if (!open) {
        // The shared arrows can reconcile on every native update. While closed
        // the companion verifies a visible conversation and maintains its trigger;
        // it never reads graph state,
        // hydrates history or starts panel observers. Labels refresh on route,
        // locale or availability changes rather than on every native commit.
        placeToggle();
        const labelKey = `${page}:${document.documentElement.lang}:${toggle.disabled}`;
        if (closedLabelKey !== labelKey) {
          label(toggle, clientText(context.element, { id: descriptors.show[0], defaultMessage: descriptors.show[1] }));
          closedLabelKey = labelKey;
        }
        return;
      }
      const id = context ? conversationKey(context) : null;
      if (owner && context && !sameGraphOwner(owner, context)) {
        resetConversationView();
        setOpen(false);
        return;
      }
      if (id !== ownerId) {
        detailHeight = null;
        releaseView(); selected = null; expanded = false;
        searchQuery = "";
        if (search) { search.value = ""; results.replaceChildren(); detail.hidden = true; }
        setStatus(null);
      }
      owner = context; ownerId = id;
      if (context && context.main !== host) {
        unmount();
        if (!mountTrigger(context)) return;
        owner = context; ownerId = id;
      }
      if (panel && !panel.isConnected) destroyPanel();
      if (!panel) mountPanel();
      dock.toggleAttribute("data-version-graph-open", open); placeToggle(); applyWidth();
      panel.setAttribute("aria-hidden", String(!open)); panel.inert = !open;
      toggle.setAttribute("aria-expanded", String(open)); label(toggle, text(open ? "hide" : "show"));
      for (const item of boundLabels) label(item.element, text(item.key), item.content);
      label(search, text("search")); search.placeholder = text("search");
      if (!open) return;
      const graph = context ? graphFor(context) : null;
      exportControls?.update(!!graph?.authoritative && !navigating && !conversationBusy(context));
      if (!graph) {
        releaseView();
        setStatus("waiting", "Waiting for conversation history…");
        return;
      }
      watchActivity(context);
      // Reconciliation already hydrates visible arrows. This also handles a
      // single-version conversation with no mounted arrow controls.
      if (!conversationBusy(context)) hydrateGraph(context, graph);
      const nextSource = graph.liveMapping ?? graph.batchMapping;
      if (source !== nextSource) {
        const first = !view;
        viewBuild?.cancel();
        source = nextSource;
        const lifetime = panelLifetime;
        viewBuild = createViewBuild(graph, {
          signal: lifetime.signal,
          complete: (nextView) => {
            viewBuild = null;
            if (lifetime.signal.aborted || panelLifetime !== lifetime || !currentOwner()) return;
            if ((graph.liveMapping ?? graph.batchMapping) !== nextSource) { schedule(); return; }
            view = nextView;
            syncCurrentBranch(graph);
            for (const control of viewportControls) control.disabled = false;
            if (selected && !view.nodes.has(selected)) selected = null;
            renderSearch();
            renderDetail();
            if (first) {
              scale = 0.8;
              centreNode(view.nodes.has(selected) ? selected : view.nodes.has(context.messageId) ? context.messageId : view.roots[0]);
            }
            if (statusKind === "building") setStatus(null);
            requestPaint();
          },
          failed: () => {
            viewBuild = null;
            if (!lifetime.signal.aborted && panelLifetime === lifetime) setStatus("error", "Unable to display this graph. Reopen the sidebar and try again.");
          },
        });
        viewBuild.start();
        if (viewBuild) setStatus("building", "Preparing graph…");
      }
      syncCurrentBranch(graph);
      go.disabled = navigating || conversationBusy(context);
      if (selected) { syncDetailTypography(); applyDetailHeight(); }
      if (!graph.authoritative) setStatus("partial", "Showing loaded history. Reopen the chat to load the full graph.");
      else if (statusKind === "waiting" || statusKind === "partial") setStatus(null);
      // Expanded state is translated separately from the fixed button labels.
      label(expand, text(expanded ? "less" : "more"), true);
    }
    const onResize = () => { if (panel) { applyWidth(); syncDetailTypography(); applyDetailHeight(); requestPaint(); } };
    addEventListener("hashchange", schedule);
    return { reconcile, isOpen: () => open, stop: () => {
      workspaceVisibility.stop();
      removeEventListener("resize", onResize); removeEventListener("hashchange", schedule); unmount();
    } };
  };

    const controller = createConversationGraph();
    if (api.testMode) globalThis.__chatgptConversationGraphTest = {
      graphMessageText, graphOverviewGeometry, graphOverviewTarget, createMessageGraphView, createViewBuild, graphViewportItems, currentBranchPaths, activeGraphContext,
      messageScroller, navigateGraphMessage, focusGraphMessage,
      reconcileGraph: controller.reconcile,
    };
    return {
      reconcile: controller.reconcile,
      stop: controller.stop,
      mutationMatters: (mutation) => {
        if (mutation.target?.nodeType === 1 &&
            mutation.target.closest?.("[data-version-graph], [data-version-graph-toggle], [data-version-graph-toggle-slot]")) return false;
        const nextRoute = location.pathname + location.hash;
        if (routeKey !== nextRoute) { routeKey = nextRoute; return true; }
        if (mutation.target?.matches?.('header[data-version-graph-header]') ||
            [...(mutation.addedNodes ?? []), ...(mutation.removedNodes ?? [])].some((node) =>
              node.nodeType === 1 && (node.matches?.('main, header, [data-testid="viewer-header"]') ||
                node.querySelector?.('main, header, [data-testid="viewer-header"]')))) return true;
        // A route can replace its titlebar after closing the panel. Maintain
        // the launcher then too, without starting graph/history work.
        // Messages may arrive after the header/history commit; that also makes
        // a loaded conversation eligible for its otherwise absent launcher.
        if ([...(mutation.addedNodes ?? []), ...(mutation.removedNodes ?? [])].some((node) =>
          node.nodeType === 1 && (node.matches?.(ASSISTANT_MESSAGE) ||
            node.querySelector?.(ASSISTANT_MESSAGE)))) return true;
      },
    };
  }), { once: true });
})();
