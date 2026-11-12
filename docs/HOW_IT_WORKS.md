# How It Works

Technical details for ChatGPT Version Arrows. For installation and the current version summary, see the [README](../README.md).

## Loading the extension

The extension is loaded at `document_start` on:

```txt
https://chatgpt.com/*
```

The JavaScript content scripts run in the page's `MAIN` world. The manifest loads them in this order:

- `core/patch.js` handles the shared configuration patch and classic-client behavior.
- `graph/` contains the message text and branch helpers, followed by the export controls and graph sidebar. These use the AppShell adapter's conversation data.
- `core/app-shell-pagination.js` handles AppShell history, version arrows, model captions, and Work prompt editing.

The styles live alongside their scripts in `core/` and `graph/` and use the client's theme.

## Full conversation history

Both client integrations use the same full-history endpoint:

```txt
GET /backend-api/conversation/<conversation_id>
```

The response contains the full message `mapping` with `parent`/`children` links, plus `current_node` identifying the selected message. These relationships are used to identify message versions and navigate branches.

## AppShell client

### Native history loader

The extension identifies ChatGPT's native conversation loader by its `forceFull` option and the paginated history request. The full request can sit in the loader itself or in a helper. The wrapper sets `forceFull: true` and combines the resulting graph with the conversation's live AppScope state.

Temporary AppShell chats use the same full-history path. Other caller options, including `isTemporaryChat`, are passed through to the loader.

A provisional `initialResponse.mapping` containing `paginated-root` is removed from the copied loader options, causing the loader to fetch the full conversation. A full initial response is retained.

Partial graphs recovered from AppScope provide read-only input for version detection. Missing version branches are restored in AppScope from a full graph. Graphs and runtime adapters are associated with their conversation owner.

The native full-history loader is the adapter's single source of full graphs.

The conversation history stays in page memory for the arrows, even with the graph panel closed. The cache targets three conversations and can temporarily hold more while entries are in use. Reloading the page clears the cache.

### Version arrows and branch selection

The adapter adds compact previous/next controls to the existing message action rows. When AppShell already renders valid native response arrows, the extension leaves them in place. It supplies matching arrows when the native controls are missing and removes false version controls when the visible graph contains only one real response.

The assistant's action row is identified by its native regenerate button or its **More actions** trigger, depending on where the client puts regeneration.

Version switching calls ChatGPT's native branch-switching function. That function saves the selected message through:

```txt
PATCH /backend-api/conversation/<conversation_id>
```

The request updates `current_node_id`, saving the selected active branch even without a new reply.

Controls remain visible but disabled during native switching, generation, and unfinished full-history loading. The adapter restores missing branches in the live AppScope graph when the relevant conversation is idle.

### Work prompt editing

The native AppShell edit path blocks user-prompt editing in Work (`tpp`) at two points:

- The conversation page omits `onEditUserMessage` for Work, so the message actions have no edit button.
- The normal Chat edit handler rejects `tpp` conversations with `Work messages cannot be edited with the Chat flow.`

The Work editor in `core/app-shell-pagination.js` supplies `onEditUserMessage` through a wrapper around the native message-action builder, connecting the existing edit button and prompt editor. On save, it builds the edited message with the client's message builder and sends it through `submitChatGPTCompletion`, carrying the target's parent, model, reasoning effort, system hints, and attachments. This uses the Work submission flow instead of the blocked Chat edit handler. The resulting version is handled by the existing graph and version arrows.

The editor uses the AppShell adapter's ownership and busy checks and rechecks the target before submission. It connects to editable, non-shared, non-temporary Work views where the native edit callback is absent.

This implementation depends on private client functions and the server accepting the resulting Work submission; its behavior after future client or server changes is unknown.

### Model and reasoning-effort captions

The model caption is added to the assistant message's existing actions menu, next to the native date information. Its values come from that message's metadata.

The graph-side fields are:

- `message.metadata.model_slug`, with `resolved_model_slug` as a fallback;
- `message.metadata.thinking_effort`;
- `message.author.role`, which must be `assistant`.

Saved and live metadata are combined, with live values taking precedence.

Human-readable names come from the client's already-loaded Chat and Work model catalogs. The matching option provides `selectedDisplayVersion` and `selectedLabel`. The fallback uses `modelConfigBySlug[slug].title` and `thinkingEfforts[].short_label`.

When no matching catalog label exists, the internal model slug is formatted and an available effort is retained as text. An absent effort is omitted.

Catalog labels can differ from the final localized labels in the native model selector. The added caption uses the client's theme color for message-date descriptions.

## Conversation graph and export

The graph panel uses the same history as the arrows. It builds the layout when opened and renders cards around the visible area. Closing the panel releases the layout. Selecting a card opens a preview; **Go to message** uses the same branch switcher as the arrows, then scrolls to the message.

Export is available once the full history is loaded and the conversation is idle. It reads the active branch from ChatGPT and prepares the full tree as JSON, the active branch as JSON, or the active branch as plain text. The file is prepared in chunks and handed to the browser for download.

## Shared configuration

### Early config hooks

`core/patch.js` wraps two functions during initialization:

- `JSON.parse`
- `Response.prototype.json`

`JSON.parse` only walks parsed objects when the original JSON text contains edited-message control markers or the exact `2605344799` conversation-loading layer id.

`Response.prototype.json` only patches parsed values from config-like responses whose URL contains one of:

```txt
statsig
initialize
bootstrap
```

Matching objects are processed through their `layer_configs` and `dynamic_configs` containers. A nested `statsigPayload` is processed as an object or a serialized JSON string.

### Edit-version experiments

The shared config patch looks for ChatGPT bootstrap/config objects with this edited-message control shape:

```js
{
  variant_modal,
  hide_pagination,
  edit_actions_treatment,
  edit_buttons_hidden,
  edit_warning,
}
```

Observed fields:

- `variant_modal`: optional. Opens older edited-message versions in a modal with a **Branch in new chat** action and is set to `false` when present.
- `hide_pagination`: older experiment flag. When `true`, ChatGPT hides the usual previous/next version arrows for edited messages.
- `edit_actions_treatment`: older experiment treatment string. Observed affected values were `"warning"` and `"branch_prefill"`.
- `edit_buttons_hidden`: edit-control visibility flag. The default value is `false`.
- `edit_warning`: edit-warning mode. The default value is `"none"`.

When that shape is found, the value is normalized to the original version-arrow behavior:

```js
{
  variant_modal: false,
  hide_pagination: false,
  edit_actions_treatment: "default",
  edit_buttons_hidden: false,
  edit_warning: "none",
}
```

Each experiment config the patch changes gets this metadata:

```js
group_name: "Control"
is_user_in_experiment: false
```

The edited-message parameter names listed above are removed from `explicit_parameters`.

Observed affected experiments:

| Experiment id | Group | Explicit parameters | Observed behavior |
| --- | --- | --- | --- |
| `1973873291` | `Test` | `variant_modal` | Shows edited-message versions through the branch modal. |
| `3879630193` | `Warning` | `hide_pagination`, `edit_actions_treatment` | Hides the edited-message version arrows and applies the warning treatment. |
| `3879348497` | `Branch Prefill` | `hide_pagination`, `edit_actions_treatment` | Hides the edited-message version arrows and applies the branch-prefill treatment. |

The patch recognizes affected configs by the field shape above. For known experiment IDs, `hide_pagination` and `edit_actions_treatment` are enough to identify the config.

## Classic client

The classic client renders its own version arrows using the normalized settings above. Its history loader is controlled by the numeric `num_turns` value in layer `2605344799`.

With a positive `num_turns` value, the affected classic frontend loads a page of messages, for example:

```txt
/backend-api/conversations/<conversation_id>?include_has_versions=true&num_turns=10
```

It requests versions separately through `/backend-api/conversations/<conversation_id>/versions?message_id=<message_id>`.

The patch sets `num_turns` to `0` and removes it from `explicit_parameters` when present. This selects the full-history endpoint and restores the classic branch-navigation path.

## Compatibility and limitations

### AppShell client

- AppShell is under active development, and its internal full-history loader, conversation state, action-row structure, and branch-switching contracts are not stable. A ChatGPT frontend update may require a corresponding extension update.
- In very long conversations, version arrows may take time to appear while the full graph loads.

### Classic client

- Version arrows for edits of the first user message are not restored in the classic client.
- Classic support depends on the current bootstrap/statsig edited-message fields and the `2605344799` layer retaining their names and meanings.

Model captions and Work prompt editing are implemented in the AppShell adapter. The classic-client integration uses the configuration patch described above.
