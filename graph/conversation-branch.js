(function () {
  "use strict";

  // Graph highlighting and export read the same committed native transcript,
  // independently of mounted/virtualized rows and the original history leaf.
  const readSelection = (context, api) => {
    const key = api.getFiber(context.element);
    let fiber = api.currentFiber(key ? context.element[key] : null), result = null;
    const ids = new Set([context.conversationId, api.conversationKey(context)]);
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || !ids.has(props.conversationId) || !Array.isArray(props.entries)) continue;
      const selected = [];
      let valid = true;
      for (const entry of props.entries) {
        if (entry?.conversationId && !ids.has(entry.conversationId)) { valid = false; break; }
        if (!Array.isArray(entry?.turn?.messageIds)) { valid = false; break; }
        for (const id of entry.turn.messageIds) if (typeof id === "string") selected.push(id);
      }
      if (valid && selected.length) result = {
        ids: selected, leaf: selected.at(-1), title: typeof props.printTitle === "string" ? props.printTitle : result?.title ?? "",
      };
    }
    return result;
  };

  const branchPath = (mapping, selection) => {
    if (!selection?.leaf || !Object.hasOwn(mapping, selection.leaf)) return { ids: [], error: "unavailable" };
    const ids = [], seen = new Set();
    for (let id = selection.leaf; id; id = mapping[id].parent) {
      if (seen.has(id) || !Object.hasOwn(mapping, id)) return { ids: [], error: "incomplete" };
      seen.add(id); ids.push(id);
    }
    if (selection.ids.some((id) => !seen.has(id))) return { ids: [], error: "changed" };
    return { ids: ids.reverse(), error: null };
  };

  const branch = Object.freeze({ readSelection, branchPath });
  addEventListener("chatgpt-version-arrows:branch-connect", (event) => {
    if (typeof event.detail === "function") event.detail(branch);
  });
})();
