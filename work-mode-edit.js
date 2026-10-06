(function () {
  "use strict";

  // Experimental Work editor. Use native UI, message construction and Work
  // submission; never compile source strings or change page security policy.
  const TEST_MODE = globalThis.__CHATGPT_WORK_EDIT_TEST__ === true;
  const wrappedFactories = new WeakSet();
  const builders = new WeakMap();
  const callbacks = new Map();
  const disabledButtons = new Map();
  const guardedButtons = new WeakSet();
  const warnings = new Set();
  let runtime = null;
  let services = null;
  let registration = null;
  let native = null;

  const sourceOf = (fn) => typeof fn === "function" ? Function.prototype.toString.call(fn) : "";
  const warn = (message) => {
    if (warnings.has(message)) return;
    warnings.add(message);
    console.warn(`[Version Arrows][Work edit] ${message}`);
  };
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isBuilder = (source) => source.includes("renderedTurns") &&
    /return\{[^{}]{0,1200}isReadOnly:[^{}]*isWorkConversation:[^{}]*onEditUserMessage:[^{}]*timestampSeparatorAtMs:/.test(source);

  const resolveNative = (candidate) => {
    if (!candidate?.m || !candidate?.c) return null;
    const factories = Object.values(candidate.m).map(sourceOf)
      .filter((source) => source.includes("Work messages cannot be edited with the Chat flow."));
    if (factories.length !== 1) return null;
    const source = factories[0];
    const marker = source.indexOf('"edit_message_unsupported_conversation"');
    const start = source.lastIndexOf("async function ", marker);
    const tail = source.slice(start).match(/\}finally\{[$\w]+\.set\(([$\w]+)\.([$\w]+),[$\w]+,!1\)\}\}/);
    if (start < 0 || !tail) return null;
    const edit = source.slice(start, start + tail.index + tail[0].length);
    const ref = (pattern) => {
      const matches = [...edit.matchAll(new RegExp(pattern, "g"))];
      if (matches.length !== 1) throw new Error("native edit reference changed");
      const [, alias, name] = matches[0];
      const binding = source.match(new RegExp(`\\b${escape(alias)}=[$\\w]+\\(["']([^"']+)["']\\)`));
      if (!binding || !candidate.c[binding[1]]) throw new Error("native edit dependency unavailable");
      return candidate.c[binding[1]].exports[name];
    };
    try {
      const busy = ref('if\\([$\\w]+\\.get\\(([$\\w]+)\\.([$\\w]+),[$\\w]+\\)\\)throw new [$\\w]+\\.[$\\w]+\\("edit_message_busy"');
      const origin = ref('let [$\\w]+=[$\\w]+\\.get\\(([$\\w]+)\\.([$\\w]+),[$\\w]+\\);if\\("tpp"===');
      const target = ref('let [$\\w]+=[$\\w]+\\.get\\(([$\\w]+)\\.([$\\w]+),\\{conversationId:[$\\w]+,messageId:[$\\w]+\\}\\);if\\(null==');
      const build = ref('\\(0,([$\\w]+)\\.([$\\w]+)\\)\\(\\{message:[$\\w]+\\.message,prompt:');
      const attachments = ref('\\(0,([$\\w]+)\\.([$\\w]+)\\)\\([$\\w]+\\.message\\.metadata\\)');
      const currentNode = ref('isRequestCurrent:\\(\\)=>[$\\w]+\\.get\\(([$\\w]+)\\.([$\\w]+),[$\\w]+\\)===');
      const status = ref('!\\(0,[$\\w]+\\.[$\\w]+\\)\\([$\\w]+\\.get\\(([$\\w]+)\\.([$\\w]+),[$\\w]+\\)\\)');
      const classify = ref('!\\(0,([$\\w]+)\\.([$\\w]+)\\)\\([$\\w]+\\.get');
      const workTask = ref('null==[$\\w]+\\.get\\(([$\\w]+)\\.([$\\w]+),[$\\w]+\\)&&');
      const requestName = edit.match(/let [$\w]+=([$\w]+)\([$\w]+\.get,[$\w]+\),[$\w]+=[$\w]+\.request\.current/)?.[1];
      const requestBody = requestName && source.match(new RegExp(
        `function ${escape(requestName)}\\([^)]*\\)\\{let [$\\w]+=[$\\w]+\\(([$\\w]+)\\.([$\\w]+),[$\\w]+\\),[$\\w]+=[$\\w]+\\(([$\\w]+)\\.([$\\w]+),[$\\w]+\\);return null==[$\\w]+\\.request\\.current&&null!=[$\\w]+\\?[$\\w]+\\(\\1\\.\\2,[$\\w]+\\):[$\\w]+\\}`,
      ));
      if (!requestBody) return null;
      const exported = (alias, name) => {
        const id = source.match(new RegExp(`\\b${escape(alias)}=[$\\w]+\\(["']([^"']+)["']\\)`))?.[1];
        return id && candidate.c[id]?.exports?.[name];
      };
      const requestState = exported(requestBody[1], requestBody[2]);
      const savedId = exported(requestBody[3], requestBody[4]);
      const submitters = new Set(Object.values(candidate.c).map((module) => {
        try { return module.exports?.submitChatGPTCompletion; } catch { return null; }
      }).filter((fn) => typeof fn === "function"));
      if (submitters.size !== 1) return null;
      const submit = [...submitters][0];
      if (![busy, origin, target, currentNode, status, workTask, requestState, savedId].every((value) => value && typeof value === "object") ||
          ![build, attachments, classify, submit].every((value) => typeof value === "function")) return null;
      return { busy, origin, target, build, attachments, currentNode, status, classify, workTask, requestState, savedId, submit };
    } catch { return null; }
  };

  const targetContext = (conversationId, messageId) => {
    const contexts = [];
    for (const element of document.querySelectorAll('[data-user-message-bubble], textarea, [contenteditable="true"]')) {
      if (!element.isConnected || !element.getClientRects().length || element.closest('[hidden], [aria-hidden="true"]')) continue;
      let context = services.readUserContext(element);
      // ProseMirror owns the editable DOM, not React. The nearest React-owned
      // container carries the same user-message context as the native editor.
      for (let host = element.parentElement, depth = 0; !context && host && depth < 8; host = host.parentElement, depth++) {
        context = services.readUserContext(host);
      }
      if (context?.conversationId !== conversationId || context.messageId !== messageId) continue;
      if (!contexts.some((other) => (other.scope.node ?? other.scope) === (context.scope.node ?? context.scope))) contexts.push(context);
    }
    if (contexts.length !== 1) throw new Error("The edited message is no longer available.");
    const context = contexts[0];
    const pageId = location.pathname.match(/\/c\/([^/]+)/)?.[1];
    if (!pageId || services.conversationKey(context) !== pageId) throw new Error("The active conversation changed.");
    return context;
  };
  const sameTarget = (left, right) => left && left.message === right.message &&
    left.parentMessageId === right.parentMessageId &&
    left.selectedModel?.slug === right.selectedModel?.slug &&
    left.selectedModel?.thinkingEffort === right.selectedModel?.thinkingEffort &&
    Array.isArray(left.systemHints) && left.systemHints.length === right.systemHints.length &&
    left.systemHints.every((hint, index) => hint === right.systemHints[index]);

  const performEdit = async (conversationId, messageId, prompt, renderFormat) => {
    native ??= resolveNative(runtime);
    if (!native) throw new Error("The native Work editor dependencies are unavailable.");
    const context = targetContext(conversationId, messageId);
    const { scope } = context;
    const key = { conversationId, messageId };
    if (scope.get(native.origin, conversationId) !== "tpp") throw new Error("This is not a Work conversation.");
    if (services.conversationBusy(context)) throw new Error("The conversation is busy.");
    const target = scope.get(native.target, key);
    if (!target || target.message?.author?.role !== "user" || typeof target.parentMessageId !== "string") {
      throw new Error("The user message could not be edited.");
    }
    const text = prompt.trim();
    const completion = native.build({ message: target.message, prompt: text, renderFormat, systemHints: target.systemHints });
    const attachments = native.attachments(completion.message.metadata);
    const content = completion.message.content;
    const hasMedia = content.content_type === "multimodal_text" && content.parts.some((part) => typeof part !== "string");
    if (!text && !attachments.length && !hasMedia) throw new Error("The edited message cannot be empty.");
    const sessionFor = () => {
      const state = scope.get(native.requestState, conversationId);
      const serverId = scope.get(native.savedId, conversationId);
      return state.request.current == null && serverId != null ? scope.get(native.requestState, serverId) : state;
    };
    const session = sessionFor();
    const request = session.request.current;
    const isCurrent = () => {
      try {
        const fresh = targetContext(conversationId, messageId);
        return (fresh.scope.node ?? fresh.scope) === (scope.node ?? scope) &&
          scope.get(native.origin, conversationId) === "tpp" &&
          sessionFor().request.current === request && sameTarget(scope.get(native.target, key), target) &&
          !native.classify(scope.get(native.status, conversationId));
      } catch { return false; }
    };
    scope.set(native.busy, conversationId, true);
    services.schedule();
    try {
      if (request != null && scope.get(session.session$) == null && scope.get(native.workTask, conversationId) == null) {
        await request.stop();
        await request.closed;
      }
      if (!isCurrent()) throw new Error("The edited message or active response changed.");
      await native.submit(scope, {
        isSubmissionCurrent: isCurrent,
        isRequestCurrent: () => scope.get(native.currentNode, conversationId) === completion.message.id,
        attachments, conversationId, isTemporaryChat: false,
        model: target.selectedModel.slug, parentMessageId: target.parentMessageId,
        prompt: text, systemHints: target.systemHints, thinkingEffort: target.selectedModel.thinkingEffort,
        userCompletionMessages: completion,
      });
    } finally {
      scope.set(native.busy, conversationId, false);
      services.schedule();
    }
  };

  const wrapBuilder = (builder) => {
    if (builders.has(builder)) return builders.get(builder);
    const wrapped = function workMessageActions(input) {
      if (input?.isWorkConversation !== true || input.isReadOnly || input.isTemporaryChat ||
          input.sharedConversationLastMessageId != null || typeof input.onEditUserMessage === "function" ||
          typeof input.conversationId !== "string") return Reflect.apply(builder, this, arguments);
      native ??= resolveNative(runtime);
      if (!native) {
        warn("The native Work edit dependencies could not be identified; editing was left unchanged.");
        return Reflect.apply(builder, this, arguments);
      }
      const id = input.conversationId;
      if (!callbacks.has(id)) {
        callbacks.set(id, (messageId, prompt, format) => performEdit(id, messageId, prompt, format));
        if (callbacks.size > 4) callbacks.delete(callbacks.keys().next().value);
      }
      return Reflect.apply(builder, this, [{ ...input, onEditUserMessage: callbacks.get(id) }]);
    };
    builders.set(builder, wrapped);
    return wrapped;
  };
  const wrapFactory = (factory) => {
    const wrapped = function workActionsFactory(module, exports, require) {
      const localRequire = function () { return Reflect.apply(require, this, arguments); };
      Object.assign(localRequire, require);
      localRequire.d = (target, getters, values) => require.d(target, Object.fromEntries(
        Object.entries(getters ?? {}).map(([name, get]) => [name, () => {
          const value = get();
          return isBuilder(sourceOf(value)) ? wrapBuilder(value) : value;
        }]),
      ), values);
      return factory(module, exports, localRequire);
    };
    wrappedFactories.add(wrapped);
    return wrapped;
  };
  const installFactories = (factories, cache) => {
    const matches = Object.entries(factories ?? {}).filter(([, factory]) =>
      !wrappedFactories.has(factory) && isBuilder(sourceOf(factory)));
    if (!matches.length) return false;
    if (matches.length !== 1 || cache?.[matches[0][0]]) {
      warn("The native action builder is ambiguous or already initialized; reload with the updated extension.");
      return true;
    }
    const [id, factory] = matches[0];
    factories[id] = wrapFactory(factory);
    return true;
  };
  const attachRuntime = (candidate) => {
    if (runtime || !candidate?.m || !candidate?.c || typeof candidate.C !== "function") return;
    runtime = candidate;
    if (installFactories(candidate.m, candidate.c)) return;
    const original = candidate.C;
    const register = function registerWorkActions(chunk) {
      if (registration && installFactories(chunk?.__webpack_modules__, candidate.c)) {
        registration = null;
        if (candidate.C === register) candidate.C = original;
      }
      return Reflect.apply(original, this, arguments);
    };
    registration = { candidate, original, register };
    candidate.C = register;
  };

  const buttonContext = (button) => {
    try {
      const context = services.readUserContext(button);
      if (!context || !native || context.scope.get(native.origin, context.conversationId) !== "tpp") return null;
      return context;
    } catch { return null; }
  };
  const restoreButton = (button, saved) => {
    saved.observer.disconnect();
    const key = Object.getOwnPropertyNames(button).find((name) => name.startsWith("__reactProps$"));
    button.disabled = key ? Boolean(button[key]?.disabled) : saved.disabled;
    disabledButtons.delete(button);
  };
  const reconcile = () => {
    if (!runtime) return;
    native ??= resolveNative(runtime);
    if (!native) return;
    const busyButtons = new Set();
    for (const button of document.querySelectorAll("button")) {
      const label = button.getAttribute("aria-label");
      const isEdit = ["Edit message", "Редактировать сообщение", "Изменить сообщение"].includes(label);
      const isSend = ["Send", "Отправить"].includes(button.textContent?.trim());
      if (!isEdit && !isSend) continue;
      const context = buttonContext(button);
      if (!context) continue;
      if (!guardedButtons.has(button)) {
        button.addEventListener("click", (event) => {
          const current = button.isConnected ? buttonContext(button) : null;
          if (!current || services.conversationBusy(current)) {
            event.preventDefault(); event.stopImmediatePropagation();
          }
        }, true);
        guardedButtons.add(button);
      }
      if (!services.conversationBusy(context)) continue;
      busyButtons.add(button);
      if (!disabledButtons.has(button)) {
        const observer = new MutationObserver(() => {
          const current = button.isConnected ? buttonContext(button) : null;
          if (current && services.conversationBusy(current) && !button.disabled) button.disabled = true;
        });
        disabledButtons.set(button, { observer, disabled: button.disabled });
        observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });
      }
      if (!button.disabled) button.disabled = true;
    }
    for (const [button, saved] of disabledButtons) if (!busyButtons.has(button)) restoreButton(button, saved);
  };
  const stop = () => {
    for (const [button, saved] of disabledButtons) restoreButton(button, saved);
    if (registration && registration.candidate.C === registration.register) registration.candidate.C = registration.original;
    registration = null;
    callbacks.clear();
  };
  if (TEST_MODE) {
    globalThis.__chatgptWorkEditTest = {
      resolveNative, wrapBuilder, wrapFactory, installFactories, attachRuntime, performEdit, reconcile, stop,
      setServices: (value) => { services = value; }, setNative: (value) => { native = value; },
    };
  } else if (typeof globalThis.__chatgptVersionArrowsConnectWork === "function") {
    globalThis.__chatgptVersionArrowsConnectWork((shared) => {
      services = shared;
      return { attachRuntime, reconcile, stop };
    });
  } else warn("The version-arrow integration is unavailable; Work editing was left unchanged.");
})();
