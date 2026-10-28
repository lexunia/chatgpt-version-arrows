(function () {
  "use strict";

  // Presentation only. Raw graph nodes and raw exports retain their content.
  const cleanCitations = (text) => text.replace(/\uE200(?:cite|filecite)\uE202[^\uE201]*\uE201/g, "");
  const messageText = (message, { attachments = false, citations = false } = {}) => {
    const content = message?.content;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const text = parts.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.transcript === "string") return part.transcript;
      const type = typeof part?.content_type === "string" ? part.content_type : "";
      return type.includes("image") ? "[Image]" : type.includes("audio") ? "[Audio]" : type.includes("video") ? "[Video]" : "";
    }).filter((part) => part !== "");
    if (!parts.length && typeof content?.text === "string") text.push(content.text);
    if (attachments && Array.isArray(message?.metadata?.attachments)) {
      for (const attachment of message.metadata.attachments) {
        if (typeof attachment?.name === "string") text.push(attachment.name);
      }
    }
    const body = text.join("\n");
    return citations ? cleanCitations(body) : body;
  };
  const presentation = Object.freeze({ messageText });
  addEventListener("chatgpt-version-arrows:text-connect", (event) => {
    if (typeof event.detail === "function") event.detail(presentation);
  });
})();
