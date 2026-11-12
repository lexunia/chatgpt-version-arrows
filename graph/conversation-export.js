(function () {
  "use strict";

  const CONNECT = "chatgpt-version-arrows:export-connect";
  const MODES = [
    ["full", "Full log (JSON)"],
    ["branch", "Current branch (JSON)"],
    ["clean", "Current branch (clean text)"],
  ];
  const fail = (message) => { const error = new Error(message); error.exportMessage = message; throw error; };
  const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

  const exportFocus = (root, trigger) => {
    let owned = root.contains(document.activeElement);
    const relinquish = (event) => { if (!root.contains(event.target)) owned = false; };
    document.addEventListener("focusin", relinquish, true);
    document.addEventListener("pointerdown", relinquish, true);
    const cancel = () => {
      document.removeEventListener("focusin", relinquish, true);
      document.removeEventListener("pointerdown", relinquish, true);
    };
    return {
      cancel,
      finish: () => {
        cancel();
        // Chromium can blur a disabled trigger to body after the menu closes.
        // Restore only while no later focus or outside pointer took ownership.
        if (owned && root.isConnected && !trigger.disabled &&
            (document.activeElement === document.body || root.contains(document.activeElement))) {
          trigger.focus({ preventScroll: true });
        }
      },
    };
  };

  let presentation, branch;
  dispatchEvent(new CustomEvent("chatgpt-version-arrows:text-connect", { detail: (value) => { presentation = value; } }));
  dispatchEvent(new CustomEvent("chatgpt-version-arrows:branch-connect", { detail: (value) => { branch = value; } }));
  if (!presentation || !branch) return;

  /** @typedef {{ids: string[], leaf: string, title: string}} NativeSelection */
  /** @typedef {{conversationId: string, graph: object, context: object, title?: string}} ExportSnapshot */

  const nativeSelection = branch.readSelection;

  const branchIds = (mapping, selection) => {
    const path = branch.branchPath(mapping, selection);
    if (path.error === "unavailable") {
      fail("Current branch is not available yet. Wait for the conversation to finish loading.");
    }
    if (path.error === "incomplete") {
      fail("Unable to read the complete current branch. Reopen the chat and try again.");
    }
    if (path.error === "changed") fail("The selected branch changed. Please try again.");
    return path.ids;
  };

  const filename = (title, conversationId, mode, date) => {
    const letters = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y",
      к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
      ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g" };
    const slug = (value) => [...value.toLowerCase()].map((c) => letters[c] ?? c).join("").normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/, "");
    const name = slug(title) || slug(conversationId) || "conversation";
    const pad = (value) => String(value).padStart(2, "0");
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    return `${name}_${stamp}_${mode === "full" ? "full" : mode === "branch" ? "current" : "current_clean"}.${mode === "clean" ? "txt" : "json"}`;
  };

  /**
   * Serialize one captured source. The caller guards owner/source identity
   * between slices and rechecks committed selection immediately before download.
   * @param {ExportSnapshot} snapshot
   * @param {"full"|"branch"|"clean"} mode
   * @param {NativeSelection|null} selection
   */
  const prepareExport = async (snapshot, mode, selection, options = {}) => {
    if (!MODES.some(([key]) => key === mode)) fail("Unknown export format.");
    const mapping = snapshot.graph.liveMapping ?? snapshot.graph.batchMapping;
    // Full exports carry current_node too: every selected entry must belong
    // to this captured mapping, even when the shared reconciliation is pending.
    const branch = selection || mode !== "full" ? branchIds(mapping, selection) : null;
    const ids = mode === "full" ? Object.keys(mapping) : branch;
    const path = mode === "full" ? null : new Set(ids);
    const parts = [], guard = options.guard ?? (() => {}), progress = options.progress ?? (() => {});
    const pause = options.pause ?? yieldToBrowser;
    const date = options.date ?? new Date();
    const title = selection?.title || snapshot.title || "";
    guard(); progress(0, ids.length); await pause(); guard();
    if (mode !== "clean") {
      parts.push('{\n"conversation_id":' + JSON.stringify(snapshot.conversationId) + ',\n"title":' + JSON.stringify(title) +
        ',\n"current_node":' + JSON.stringify(selection?.leaf ?? null) + ',\n"mapping":{\n');
    }
    let written = 0, sliceStart = performance.now();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i], node = mapping[id];
      if (mode === "clean") {
        const role = snapshot.graph.mapping[id]?.visibleRole;
        if (role) {
          const body = presentation.messageText(node.message, { citations: role === "assistant" });
          parts.push(`${written++ ? "\n\n" : ""}${role === "user" ? "USER" : "ASSISTANT"}:\n${body}`);
        }
      } else {
        // Prune alternate child links in a branch export without mutating the
        // original full graph or dropping other node/message metadata.
        const value = path ? { ...node, children: (node.children ?? []).filter((child) => path.has(child)) } : node;
        parts.push(`${written++ ? ",\n" : ""}${JSON.stringify(id)}:${JSON.stringify(value)}`);
      }
      if ((i + 1) % 200 === 0 || performance.now() - sliceStart >= 8) {
        progress(i + 1, ids.length); await pause(); guard(); sliceStart = performance.now();
      }
    }
    parts.push(mode === "clean" ? "\n" : "\n}\n}\n");
    progress(ids.length, ids.length); await pause(); guard();
    return {
      blob: new Blob(parts, { type: mode === "clean" ? "text/plain;charset=utf-8" : "application/json;charset=utf-8" }),
      filename: filename(title, snapshot.conversationId, mode, date),
    };
  };

  const createExportControls = ({ parent, read, api }) => {
    let disposed = false, running = false, available = false, noticeTimer = null, focus = null;
    const root = document.createElement("div"); root.className = "version-graph-export"; parent.append(root);
    const trigger = document.createElement("button"); trigger.type = "button";
    trigger.className = "version-graph-button version-graph-export-trigger";
    trigger.setAttribute("aria-haspopup", "menu"); trigger.setAttribute("aria-expanded", "false");
    const caption = document.createElement("span"); caption.className = "version-graph-export-label"; caption.textContent = "Export";
    const spinner = document.createElement("span"); spinner.className = "version-graph-export-spinner"; spinner.hidden = true; spinner.setAttribute("aria-hidden", "true");
    trigger.append(caption, spinner); root.append(trigger);
    const menu = document.createElement("div"); menu.className = "version-graph-export-menu"; menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Export conversation"); menu.hidden = true; root.append(menu);
    const notice = document.createElement("div"); notice.className = "version-graph-export-notice";
    notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite"); notice.hidden = true; root.append(notice);
    const hideMenu = () => { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside); };
    const outside = (event) => { if (!root.contains(event.target)) hideMenu(); };
    const showMenu = () => {
      if (!available || running) return;
      menu.hidden = false; notice.hidden = true; trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", outside); menu.firstElementChild.focus();
    };
    const controlsState = () => {
      trigger.disabled = running || !available;
      trigger.setAttribute("aria-label", running ? "Preparing export" : "Export conversation");
      trigger.title = running ? "Preparing export..." : available ? "Export conversation" : "Wait for the full conversation to finish loading";
      root.classList.toggle("is-exporting", running); spinner.hidden = !running;
      trigger.setAttribute("aria-busy", String(running));
    };
    const run = async (mode) => {
      if (disposed || running || !available) return;
      // Return keyboard focus while closing the menu, before any async work.
      // Completion must not pull focus back from the composer or graph search.
      focus = exportFocus(root, trigger);
      const menuHadFocus = menu.contains(document.activeElement);
      hideMenu();
      if (menuHadFocus) trigger.focus({ preventScroll: true });
      running = true;
      clearTimeout(noticeTimer);
      controlsState();
      notice.hidden = false; notice.textContent = "Preparing export...";
      try {
        await yieldToBrowser();
        if (disposed) return;
        const initial = read();
        if (!initial.graph?.authoritative) fail("Full conversation history is not available yet. Reopen the chat and try again.");
        const source = initial.graph.liveMapping ?? initial.graph.batchMapping;
        const selected = nativeSelection(initial.context, api);
        const guard = () => {
          if (disposed) throw new Error("Export cancelled");
          const current = read();
          if (current.conversationId !== initial.conversationId || (current.context.scope.node ?? current.context.scope) !==
              (initial.context.scope.node ?? initial.context.scope) || (current.graph?.liveMapping ?? current.graph?.batchMapping) !== source) {
            fail("The conversation changed during export. Please try again.");
          }
        };
        const result = await prepareExport(initial, mode, selected, {
          guard, progress: (done, total) => { notice.textContent = `Preparing export... ${done} / ${total} items`; },
        });
        guard();
        const now = nativeSelection(read().context, api);
        if (now?.leaf !== selected?.leaf || now?.ids.length !== selected?.ids.length ||
            now?.ids.some((id, index) => id !== selected.ids[index])) {
          fail("The selected branch changed during export. Please try again.");
        }
        const url = URL.createObjectURL(result.blob), link = document.createElement("a");
        link.href = url; link.download = result.filename;
        try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
        notice.textContent = "Download started.";
        noticeTimer = setTimeout(() => { notice.hidden = true; }, 3000);
      } catch (error) {
        if (!disposed) notice.textContent = error.exportMessage ?? "Unable to prepare export. Please try again.";
      } finally {
        running = false;
        if (!disposed) {
          controlsState();
          focus.finish();
        }
        focus = null;
      }
    };
    for (const [mode, title] of MODES) {
      const item = document.createElement("button"); item.type = "button"; item.textContent = title;
      item.setAttribute("role", "menuitem"); item.dataset.exportMode = mode;
      item.addEventListener("click", () => { void run(mode); }); menu.append(item);
    }
    trigger.addEventListener("click", () => { menu.hidden ? showMenu() : hideMenu(); });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) { hideMenu(); trigger.focus(); event.preventDefault(); event.stopPropagation(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && !running) {
        event.preventDefault(); event.stopPropagation();
        if (menu.hidden) { showMenu(); return; }
        const items = [...menu.children], index = items.indexOf(document.activeElement);
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
          (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
    });
    controlsState();
    return {
      update: (enabled) => { available = enabled; if (!enabled) hideMenu(); controlsState(); },
      dispose: () => {
        disposed = true;
        focus?.cancel();
        hideMenu();
        clearTimeout(noticeTimer);
        root.remove();
      },
    };
  };

  addEventListener(CONNECT, (event) => { if (typeof event.detail === "function") event.detail(createExportControls); });
  if (globalThis.__CHATGPT_EDIT_PAGINATION_PATCH_TEST__ === true) {
    globalThis.__chatgptConversationExportTest = { nativeSelection, branchIds, filename, prepareExport };
  }
})();
