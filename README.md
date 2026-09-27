# ChatGPT Version Arrows

Restores the previous/next version arrows for edited messages and regenerated responses, so you can switch between versions directly in the conversation. Works with both ChatGPT's classic web client and the newer AppShell client.

<p align="center">
  <img
    src="assets/pagination-demo.png"
    alt="ChatGPT conversation showing restored previous and next version arrows"
    width="900"
  >
</p>

## Download and Install

1. On this GitHub page, click the **Code** button above the file list.
2. Click **Download ZIP**.
3. When the download finishes, open your Downloads folder.
4. Right-click the downloaded ZIP file and select **Extract All**.
5. Move the extracted `chatgpt-version-arrows-main` folder to a permanent location where you will not delete or move it later.
6. Open the extracted folder and make sure it contains `manifest.json`, `patch.js`, `app-shell-pagination.js`, and `app-shell-pagination.css`.
7. Open Chrome and enter `chrome://extensions` in the address bar.
8. Enable **Developer mode** in the top-right corner.
9. Click **Load unpacked**.
10. Select the extracted folder that directly contains `manifest.json`. Do not select the ZIP file, the `assets` folder, or a parent folder.
11. Make sure the extension appears on the Extensions page and is enabled.
12. Reload every open ChatGPT tab with `Ctrl+Shift+R`.

> Keep the extracted folder after installation. Chrome loads the extension directly from that location. If you delete, rename, or move the folder, the extension may stop working and will need to be loaded again.

If Chrome reports that the manifest is missing or unreadable, you selected the wrong folder. Select the folder that directly contains `manifest.json`.

## What's New in 0.6.0

ChatGPT is rolling out a new client framework called **AppShell** alongside the classic web client. AppShell is the shared application shell around conversations, navigation, tabs, and panels. It uses a different conversation-loading and state model, so the classic config patch alone cannot restore the previous/next version arrows there.

This version adds AppShell support while preserving the existing classic-client behavior:

- Previous/next version arrows are restored for edited user messages and regenerated assistant responses.
- The experimental **See versions** / **Branch in new chat** interface is suppressed in AppShell.

## What It Changes

### AppShell client

AppShell loads conversation graphs through:

```txt
POST /backend-api/conversations/batch
```

The response already contains the branch graph needed to identify edited user messages and regenerated assistant responses. The AppShell adapter combines that graph with ChatGPT's live AppScope state, adds compact previous/next controls to the existing action rows, and uses ChatGPT's native branch switcher to change the active version.

When AppShell already renders valid native response arrows, the extension leaves them in place. It supplies matching arrows when the native controls are missing and removes false version controls when the visible graph contains only one real response.

Edited **user messages in AppShell** also show numbered version buttons between
the previous/next arrows. Click a number to jump directly to that version through
the same native branch switcher. The current version is highlighted; long lists
scroll horizontally. Buttons remain disabled while a switch is pending, and the
existing accessible count/error announcement is preserved. Assistant response
controls and the classic client's native controls are unchanged.

### Classic client

The classic client uses ChatGPT's original version-arrow components. The extension restores them by normalizing the relevant bootstrap configuration before the frontend reads it.

#### Message-version loading rollout

An observed classic-client rollout is controlled by this bootstrap layer:

```js
layer_configs["2605344799"].value.num_turns
```

An observed affected value is:

```js
{
  "2605344799": {
    value: {
      num_turns: 10,
    },
    parameter_rule_ids: {
      num_turns: "shippedValues:chatgpt-web-paginated-messages-rollout",
    },
  },
}
```

With a positive `num_turns` value, the affected classic frontend selects:

```txt
/backend-api/conversations/<conversation_id>?include_has_versions=true&num_turns=10
```

This endpoint returns a `messages` payload and handles message versions separately.

Message versions can be requested separately through:

```txt
/backend-api/conversations/<conversation_id>/versions?message_id=<message_id>
```

The original classic path uses:

```txt
/backend-api/conversation/<conversation_id>
```

This endpoint returns the full conversation `mapping`, including the `parent`, `children`, and `current_node` relationships used by the original branch controls.

The extension changes `num_turns` to `0` before ChatGPT reads the config. In the affected classic frontend, `0` selects the original loading and branch-navigation path.

If `num_turns` appears in `explicit_parameters`, only that entry is removed. Other parameters and rollout metadata are preserved.

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

- `variant_modal`: opens older edited-message versions in a modal with a **Branch in new chat** action.
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

For known affected experiment configs, metadata is also normalized:

```js
group_name: "Control"
is_user_in_experiment: false
```

These edited-message entries are removed from `explicit_parameters`; unrelated entries are preserved.

Observed affected experiments:

| Experiment id | Group | Explicit parameters | Observed behavior |
| --- | --- | --- | --- |
| `1973873291` | `Test` | `variant_modal` | Shows edited-message versions through the branch modal. |
| `3879630193` | `Warning` | `hide_pagination`, `edit_actions_treatment` | Hides the edited-message version arrows and applies the warning treatment. |
| `3879348497` | `Branch Prefill` | `hide_pagination`, `edit_actions_treatment` | Hides the edited-message version arrows and applies the branch-prefill treatment. |

Known experiment ids are used only as secondary markers.

For these experiment configs, the primary match is the edited-message field shape, not a user id or account-specific id. The classic conversation-loading rollout is matched separately by the exact `2605344799` layer id and its numeric `num_turns` value.

## How It Works

The extension is loaded at `document_start` on:

```txt
https://chatgpt.com/*
```

Both JavaScript content scripts run in the page's `MAIN` world.

### Shared config patch and classic client

`patch.js` installs two constrained early hooks:

- `JSON.parse`
- `Response.prototype.json`

`JSON.parse` only walks parsed objects when the original JSON text contains edited-message control markers or the exact `2605344799` conversation-loading layer id.

`Response.prototype.json` only patches parsed values from config-like responses whose URL contains one of:

```txt
statsig
initialize
bootstrap
```

For other backend responses, it returns the original parsed result without patching it.

After the matching config is normalized, the classic frontend renders and operates its own native previous/next version arrows.

### AppShell adapter

`app-shell-pagination.js` is loaded on every matching ChatGPT page, but it renders and switches version controls only after detecting the AppShell client. It captures the exact `/backend-api/conversations/batch` response, combines that graph with the corresponding live AppScope state, and reconciles the controls with the current message action rows.

The adapter uses ChatGPT's native branch-switching function.

## Development tests

Install the test-only dependency with `npm install`, then install a test browser
with `npx playwright install chromium` and run `npm test` (Node.js 20 or newer).
Alternatively, set `BROWSER_EXECUTABLE` to an installed Chrome or Edge executable.
Tests launch a separate headless browser with synthetic conversations; they do
not connect to a logged-in profile or make requests to ChatGPT.

## Known Limits

### AppShell client

- AppShell is under active development, and its internal conversation state, action-row structure, and branch-switching contracts are not stable. A ChatGPT frontend update may require a corresponding extension update.

### Classic client

- Version arrows for edits of the first user message are not restored in the classic client.
- Classic support depends on the current bootstrap/statsig edited-message fields and the `2605344799` layer retaining their names and meanings.
