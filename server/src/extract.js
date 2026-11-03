const FENCE = /```(?:python|python3|py)?\s*\n([\s\S]*?)```/i;

export function extractPython(text) {
  if (!text || typeof text !== "string") return null;
  const fenced = text.match(FENCE);
  if (fenced) {
    const code = fenced[1].replace(/\s+$/, "");
    return code.trim() ? code + "\n" : null;
  }
  const trimmed = text.trim();
  if (/^(import |from |print\(|def |#|"""|'''|if |for |with )/m.test(trimmed)) {
    return trimmed + "\n";
  }
  return null;
}

export function reviewCode(code) {
  if (!code || !code.trim()) return "The model did not return Python.";
  if (code.length > 50_000) return "Generated code is too large.";
  if (code.includes("VULTR_INFERENCE_API_KEY")) {
    return "Rejected: generated code tried to read the inference API key.";
  }
  return null;
}

export function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("\n");
  }
  return "";
}
