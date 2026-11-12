(function () {
  "use strict";

  const EXPERIMENT_IDS = new Set(["3879630193", "3879348497", "1973873291"]);
  const EDIT_PARAMETER_NAMES = new Set([
    "hide_pagination",
    "edit_buttons_hidden",
    "edit_actions_treatment",
    "edit_warning",
    "variant_modal",
  ]);
  const PAGINATED_MESSAGES_LAYER_ID = "2605344799";
  const TEXT_NEEDLE = /hide_pagination|edit_actions_treatment|2605344799/;
  const INTERESTING_URL = /statsig|initialize|bootstrap/i;
  const INTERESTING_CONTENT_TYPE = /json|javascript|text|html/i;
  const MAX_JSON_STRING_DEPTH = 2;
  const originalParse = JSON.parse;
  const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

  const hasEditPaginationShape = (value) =>
    value &&
    typeof value === "object" &&
    "hide_pagination" in value &&
    "edit_buttons_hidden" in value &&
    "edit_actions_treatment" in value &&
    "edit_warning" in value &&
    typeof value.hide_pagination === "boolean" &&
    typeof value.edit_buttons_hidden === "boolean" &&
    typeof value.edit_actions_treatment === "string" &&
    typeof value.edit_warning === "string" &&
    (!("variant_modal" in value) || typeof value.variant_modal === "boolean");

  const hasCoreEditPaginationShape = (value) =>
    value &&
    typeof value === "object" &&
    "hide_pagination" in value &&
    "edit_actions_treatment" in value;

  const normalizeEditPaginationValue = (value) => {
    value.hide_pagination = false;
    value.edit_buttons_hidden = false;
    value.edit_actions_treatment = "default";
    value.edit_warning = "none";
    if ("variant_modal" in value) value.variant_modal = false;
  };

  const isDefaultEditPaginationValue = (value) =>
    value.hide_pagination === false &&
    value.edit_buttons_hidden === false &&
    value.edit_actions_treatment === "default" &&
    value.edit_warning === "none" &&
    (!("variant_modal" in value) || value.variant_modal === false);

  const shouldPatchResponse = (url, contentType) =>
    INTERESTING_URL.test(url) &&
    INTERESTING_CONTENT_TYPE.test(contentType) &&
    !/text\/event-stream/i.test(contentType);

  const patchExperimentConfig = (cfg) => {
    if (!cfg || typeof cfg !== "object") return false;

    const value = cfg.value;
    const isKnownExperiment = EXPERIMENT_IDS.has(String(cfg.allocated_experiment_name));
    const hit =
      (hasEditPaginationShape(value) && !isDefaultEditPaginationValue(value)) ||
      (isKnownExperiment && hasCoreEditPaginationShape(value));

    if (!hit) return false;

    const explicitParameters = Array.isArray(cfg.explicit_parameters)
      ? cfg.explicit_parameters.filter((name) => !EDIT_PARAMETER_NAMES.has(name))
      : [];
    const changed = !isDefaultEditPaginationValue(value) ||
      cfg.group_name !== "Control" || cfg.is_user_in_experiment !== false ||
      !Array.isArray(cfg.explicit_parameters) ||
      explicitParameters.length !== cfg.explicit_parameters.length;
    if (!changed) return false;

    normalizeEditPaginationValue(value);
    cfg.group_name = "Control";
    cfg.is_user_in_experiment = false;
    cfg.explicit_parameters = explicitParameters;

    return true;
  };

  const patchPaginatedMessagesConfig = (cfg) => {
    if (
      !cfg ||
      typeof cfg !== "object" ||
      String(cfg.name) !== PAGINATED_MESSAGES_LAYER_ID ||
      !cfg.value ||
      typeof cfg.value !== "object" ||
      typeof cfg.value.num_turns !== "number" ||
      cfg.value.num_turns === 0
    ) {
      return false;
    }

    cfg.value.num_turns = 0;
    if (Array.isArray(cfg.explicit_parameters)) {
      cfg.explicit_parameters = cfg.explicit_parameters.filter((name) => name !== "num_turns");
    }

    return true;
  };

  const patchPossiblyJsonText = (text, jsonStringDepth = 0, seen = new WeakSet()) => {
    if (typeof text !== "string" || !TEXT_NEEDLE.test(text) ||
        jsonStringDepth > MAX_JSON_STRING_DEPTH) return text;
    try {
      const parsed = originalParse.call(JSON, text);
      if (patchConfigObject(parsed, jsonStringDepth, seen)) return JSON.stringify(parsed);
    } catch {
      // Never apply text replacements to prose, HTML or malformed JSON.
    }
    return text;
  };

  const patchConfigObject = (root, jsonStringDepth, seen) => {
    if (!isRecord(root) || seen.has(root)) return false;
    seen.add(root);
    let changed = false;

    // These are Statsig configuration containers, not arbitrary application
    // fields. Do not descend into messages, config metadata or config values.
    for (const category of ["layer_configs", "dynamic_configs"]) {
      if (!Object.hasOwn(root, category) || !isRecord(root[category])) continue;
      const configs = root[category];
      if (category === "layer_configs" && Object.hasOwn(configs, PAGINATED_MESSAGES_LAYER_ID)) {
        changed = patchPaginatedMessagesConfig(configs[PAGINATED_MESSAGES_LAYER_ID]) || changed;
      }
      for (const cfg of Object.values(configs)) changed = patchExperimentConfig(cfg) || changed;
    }

    // Saved classic bootstraps contain a serialized Statsig payload. Only this
    // named envelope may contain another configuration object/JSON string.
    if (Object.hasOwn(root, "statsigPayload")) {
      const payload = root.statsigPayload;
      if (typeof payload === "string") {
        const patched = patchPossiblyJsonText(payload, jsonStringDepth + 1, seen);
        if (patched !== payload) { root.statsigPayload = patched; changed = true; }
      } else {
        changed = patchConfigObject(payload, jsonStringDepth, seen) || changed;
      }
    }
    return changed;
  };

  const patchObject = (root, jsonStringDepth = 0) => {
    patchConfigObject(root, jsonStringDepth, new WeakSet());
    return root;
  };

  JSON.parse = function patchedParse(text, reviver) {
    const parsed = originalParse.call(this, text, reviver);
    return typeof text === "string" && TEXT_NEEDLE.test(text) ? patchObject(parsed, 0) : parsed;
  };

  const originalResponseJson = Response.prototype.json;
  Response.prototype.json = function patchedResponseJson(...args) {
    const parsedPromise = originalResponseJson.apply(this, args);
    const url = String(this.url ?? "");
    const contentType = this.headers.get("content-type") ?? "";

    if (!shouldPatchResponse(url, contentType)) return parsedPromise;

    return parsedPromise.then((parsed) => {
      if (typeof parsed === "string") return patchPossiblyJsonText(parsed);
      return patchObject(parsed, 0);
    });
  };

  if (globalThis.__CHATGPT_EDIT_PAGINATION_PATCH_TEST__ === true) {
    globalThis.__chatgptEditPaginationPatch = {
      hasEditPaginationShape,
      isDefaultEditPaginationValue,
      normalizeEditPaginationValue,
      patchObject,
      patchPaginatedMessagesConfig,
      patchPossiblyJsonText,
      shouldPatchResponse,
    };
  }
})();
