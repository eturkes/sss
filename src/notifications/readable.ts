import { load } from "cheerio";
import type { ChangeEvent, JsonObject, JsonValue, MonitorStatus } from "../core/types.ts";
import { stripControlText } from "../security/text.ts";

const CONTENT = ["abstract", "summary", "description", "encoded", "content", "text", "body"];
const DIAGNOSTICS = new Set(["diagnostics", "logs", "log", "namespace", "runId", "ruleId"]);
const INTERNAL = new Set(["id", "postId", "title", "url", "snippet", ...DIAGNOSTICS]);
const HTML_TAG = /^(?:[\w-]+:)?(?:html|head|body|title|div|span|p|a|b|i|em|strong|u|s|small|sup|sub|code|pre|br|hr|h[1-6]|ul|ol|li|dl|dt|dd|blockquote|table|thead|tbody|tfoot|tr|td|th|caption|section|article|figure|figcaption|img|script|style|iframe|object|embed|form|input|meta|link|base|template|noscript|abstract|sec|label|italic|bold|ext-link|xref|list|list-item|break|inline-formula|disp-formula|math|mrow|mi|mn|mo|msup|msub|msubsup|mfrac|msqrt|mroot)$/i;
const VOID_TAG = /^(?:br|hr|img|input|meta|link|base|embed|break)$/i;
const BLOCK = new Set(["html", "body", "div", "p", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "dt", "dd", "blockquote", "table", "tr", "caption", "section", "article", "figure", "figcaption", "abstract", "sec", "title", "list"]);

function record(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function string(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? stripControlText(value) : undefined;
}

function link(value: string | undefined, base?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = stripControlText(value).trim();
  try {
    const parsed = new URL(cleaned, base);
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) return undefined;
    // Validate without canonicalizing authored Unicode/spacing in absolute URLs or fragments.
    if (/^(?:https?:\/\/|mailto:)/i.test(cleaned)) return cleaned;
    const fragment = cleaned.indexOf("#");
    return fragment < 0 ? parsed.href : parsed.href.split("#")[0] + cleaned.slice(fragment);
  } catch { return undefined; }
}

/** Presentation only: source observations retain their original bytes in the store. */
export function readableText(value: string, base?: string, html = false): string {
  const clean = stripControlText(value);
  const closed = new Set([...clean.matchAll(/<\/([\w:-]+)\s*>/g)].map(match => match[1]!.toLowerCase()));
  let markup = false;
  const protectedText = clean.replace(/<\/?([\w:-]+)\b[^>]*>/g, (tag, name: string) => {
    if (HTML_TAG.test(name) && (html || closed.has(name.toLowerCase()) || VOID_TAG.test(name) || tag.endsWith("/>"))) { markup = true; return tag; }
    return tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  });
  if (!markup && !/&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(clean)) return clean;
  const $ = load(protectedText, {}, false);
  $("script, style, iframe, object, embed, template, noscript, head, base, meta, link, input").remove();
  const nodes = $.root().contents().toArray();
  const codeBlocks: string[] = [];
  const visit = (node: (typeof nodes)[number], pre = false): string => {
    if (node.type === "text") return pre ? node.data : node.data.replace(/\s+/g, " ");
    if (!("name" in node) || !("children" in node)) return "";
    const tag = node.name.toLowerCase().split(":").at(-1)!;
    if (["script", "style", "iframe", "object", "embed", "template", "noscript"].includes(tag)) return "";
    const children = node.children.map(child => visit(child, pre || tag === "pre"));
    const text = children.join("");
    if (tag === "pre") {
      codeBlocks.push(text);
      return `\n\n\u0000PRE${codeBlocks.length - 1}\u0000\n\n`;
    }
    if (tag === "sup" || tag === "sub") return `${tag === "sup" ? "^" : "_"}(${text})`;
    const terms = children.filter(child => child.trim());
    if (tag === "msup" || tag === "msub") return `${terms[0] ?? ""}${tag === "msup" ? "^" : "_"}(${terms.slice(1).join("")})`;
    if (tag === "msubsup") return `${terms[0] ?? ""}_(${terms[1] ?? ""})^(${terms[2] ?? ""})`;
    if (tag === "mfrac") return `(${terms[0] ?? ""})/(${terms.slice(1).join("")})`;
    if (tag === "msqrt") return `sqrt(${text})`;
    if (tag === "mroot") return `root(${terms[1] ?? ""}, ${terms[0] ?? ""})`;
    if (tag === "br" || tag === "break") return "\n";
    if (tag === "hr") return "\n\n";
    if (tag === "a" || tag === "ext-link") {
      const href = link(node.attribs["href"] ?? node.attribs["xlink:href"], base);
      return href && href !== text.trim() ? `${text.trim() || "Link"} (${href})` : text;
    }
    if (tag === "img") {
      const src = link(node.attribs["src"], base);
      const alt = stripControlText(node.attribs["alt"] ?? "");
      return `\nImage${alt ? `: ${alt}` : ""}${src ? ` (${src})` : ""}\n`;
    }
    if (tag === "li" || tag === "list-item") return `\n- ${text.trim()}\n`;
    if (tag === "td" || tag === "th") return `${text.trim()}\t`;
    return BLOCK.has(tag) ? `\n\n${text.trim()}\n\n` : text;
  };
  const rendered = nodes.map(node => visit(node)).join("").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+(?=\n)/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    .replace(/\u0000PRE(\d+)\u0000/g, (_, index: string) => codeBlocks[Number(index)]!);
  return stripControlText(rendered);
}

export function displayTime(value: string, timezone = "UTC"): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return stripControlText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at)} (${timezone})`;
}

function label(key: string): string {
  const words = stripControlText(key).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fields(value: JsonValue, base?: string, indent = ""): string[] {
  if (typeof value === "string") return [indent + readableText(value, base)];
  if (value === null) return [indent + "Not available"];
  if (typeof value !== "object") return [indent + String(value)];
  if (Array.isArray(value)) return value.flatMap(item => fields(item, base, `${indent}- `));
  return Object.entries(value).filter(([key]) => !DIAGNOSTICS.has(key)).flatMap(([key, item]) =>
    typeof item === "object" && item !== null
      ? [`${indent}${label(key)}:`, ...fields(item, base, indent + "  ")]
      : [`${indent}${label(key)}: ${fields(item, base).join("\n")}`]);
}

function discussionComments(comments: JsonObject[], base: string | undefined, timezone: string, threadId: JsonValue | undefined): string[] {
  const identities = new Map<string, string>();
  const numbers = new Map<string, string>();
  const key = (value: JsonValue | undefined) => typeof value === "number" || typeof value === "string" ? String(value) : undefined;
  const root = link(base);
  if (root) {
    if (key(threadId) !== undefined) identities.set(key(threadId)!, root);
    numbers.set("1", root);
  }
  for (const comment of comments) {
    const url = link(string(comment["url"]), base);
    if (!url) continue;
    if (key(comment["id"]) !== undefined) identities.set(key(comment["id"])!, url);
    if (key(comment["postNumber"]) !== undefined) numbers.set(key(comment["postNumber"])!, url);
  }
  const parts = ["", `Comments (${comments.length})`];
  for (const comment of comments) {
    const author = string(comment["author"]);
    const published = string(comment["publishedAt"]);
    const url = link(string(comment["url"]), base);
    const status = comment["unavailable"] === true ? "Unavailable comment" : comment["deleted"] === true ? "Deleted comment" : comment["moderated"] === true ? "Moderated comment" : comment["dead"] === true ? "Flagged comment" : "Comment";
    parts.push("", `${status}${author ? ` by ${author}` : ""}${published ? ` · ${displayTime(published, timezone)}` : ""}`);
    if (url) parts.push(url);
    const parent = key(comment["parentId"] ?? comment["parent"]);
    const parentNumber = key(comment["parentNumber"]);
    const parentUrl = link(string(comment["parentUrl"]), base) ?? (parent === undefined ? undefined : identities.get(parent)) ?? (parentNumber === undefined ? undefined : numbers.get(parentNumber));
    if (parentUrl) parts.push(`In reply to: ${parentUrl}`);
    const seen = new Set<string>();
    for (const field of ["body", "text"]) {
      const text = string(comment[field]);
      if (!text) continue;
      // These adapters acquire publisher HTML, including HN's unclosed paragraph tags.
      const rendered = readableText(text, url ?? base, true);
      if (rendered && !seen.has(rendered)) { seen.add(rendered); parts.push("", rendered); }
    }
    const known = new Set(["id", "postId", "postNumber", "url", "author", "publishedAt", "body", "text", "parent", "parentId", "parentNumber", "parentUrl", "deleted", "moderated", "dead", "unavailable", "hidden", "userDeleted", "deletedAt"]);
    const extra = Object.fromEntries(Object.entries(comment).filter(([key]) => !known.has(key)));
    if (Object.keys(extra).length) parts.push(...fields(extra, url ?? base));
  }
  return parts;
}

function observation(value: JsonValue, base: string | undefined, timezone: string, metadata?: JsonObject): string[] {
  const data = record(value);
  if (!data) return fields(value, base);
  const parts: string[] = [];
  const used = new Set([...INTERNAL, ...CONTENT]);
  const rawComments = data["comments"];
  const comments = Array.isArray(rawComments) && rawComments.every(comment => record(comment) !== undefined) ? rawComments as JsonObject[] : undefined;
  const author = data["authors"] ?? data["author"];
  if (author !== undefined) {
    used.add(data["authors"] !== undefined && data["authors"] !== null ? "authors" : "author");
    parts.push(`By ${Array.isArray(author) ? author.map(item => fields(item, base).join(" ")).join(", ") : fields(author, base).join(" ")}`);
  }
  const published = string(metadata?.["publishedAt"]) ?? string(data["publishedAt"]);
  if (published) parts.push(`Published: ${displayTime(published, timezone)}`);
  if (string(data["publishedAt"])) used.add("publishedAt");
  const updated = string(data["updatedAt"]);
  if (updated && updated !== published) parts.push(`Updated: ${displayTime(updated, timezone)}`);
  if (updated) used.add("updatedAt");
  const seen = new Set<string>();
  for (const key of CONTENT) {
    const value = data[key];
    if (value === undefined) continue;
    const raw = string(value);
    if (!raw) { parts.push("", `${label(key)}:`, ...fields(value, base)); continue; }
    // Browser posts are plain text; discussion APIs identify their bodies as publisher HTML.
    const rendered = key === "text" && comments === undefined ? raw : readableText(raw, base, comments !== undefined);
    if (seen.has(rendered) || !rendered.trim()) continue;
    seen.add(rendered);
    parts.push("", ...(key === "text" ? ["Post"] : []), rendered);
  }
  for (const [key, heading] of [["quotedText", "Quoted post"], ["quotedContext", "Quote context"], ["context", "Conversation context"]]) {
    const text = string(data[key!]);
    if (text) {
      used.add(key!);
      // Browser-only conversation headings contain no observed conversation.
      const emptyContext = key === "context" && /^\s*#{1,6}\s+Conversation\s*$/i.test(text);
      if (!emptyContext && !seen.has(text)) { seen.add(text); parts.push("", heading!, text); }
    }
  }
  if (Array.isArray(data["links"])) {
    used.add("links");
    const links = data["links"].flatMap(item => {
      if (typeof item !== "string") return fields(item, base, "- ");
      const url = link(item, base);
      return url && !parts.some(part => part.includes(url)) ? [`- ${url}`] : [];
    });
    if (links.length) parts.push("", "Links", ...links);
  }
  if (Array.isArray(data["media"])) {
    used.add("media");
    if (data["media"].length) {
    parts.push("", "Media (links only)");
    for (const item of data["media"]) {
      const media = record(item);
      const url = link(string(media?.["url"]) ?? string(item), base);
      const alt = string(media?.["alt"]);
      if (url) parts.push(`- ${alt ?? "Image"}: ${url}`);
      else if (alt) parts.push(`- ${alt}`);
      else if (media) parts.push(...fields(media, base, "- "));
    }
    }
  }
  if (comments !== undefined) {
    for (const key of ["comments", "threadId", "postCount", "commentCount"]) used.add(key);
    parts.push(...discussionComments(comments, base, timezone, data["threadId"]));
  }
  const other = Object.fromEntries(Object.entries(data).filter(([key]) => !used.has(key)));
  if (Object.keys(other).length) parts.push("", ...fields(other, base));
  return parts;
}

export function eventContent(event: ChangeEvent, timezone = "UTC"): string[] {
  const after = record(event.after);
  const assessment = record(after?.["assessment"]);
  const post = record(after?.["post"]);
  const parts: string[] = [];
  if (event.kind === "llm_assessment" && assessment) {
    const reason = string(assessment["reason"]) ?? event.reason;
    parts.push("Assessment (model interpretation)", stripControlText(reason));
    const evidence = assessment["evidence"];
    if (Array.isArray(evidence) && evidence.length) parts.push("", "Evidence", ...evidence.flatMap(item => fields(item, event.url, "- ")));
    const observed = post?.["data"] ?? Object.fromEntries(Object.entries(after!).filter(([key]) => key !== "assessment"));
    parts.push("", ...observation(observed, event.url, timezone, post));
    if (event.before !== undefined) parts.push("", "Previous observation", ...fields(event.before, event.url));
    const model = string(assessment["model"]);
    const effort = string(assessment["reasoningEffort"]);
    if (model) parts.push("", `Assessed by ${model}${effort ? ` (${effort})` : ""}. This is not independent confirmation.`);
  } else {
    if (event.kind !== "new_item") parts.push(stripControlText(event.reason));
    if (event.before !== undefined) parts.push("", "Before", ...fields(event.before, event.url), "", "After");
    parts.push(...(event.kind === "new_item" ? observation(event.after, event.url, timezone) : fields(event.after, event.url)));
  }
  return parts;
}

export function sourceHealth(monitors: MonitorStatus[], events: ChangeEvent[], timezone: string): string[] {
  const healthy = monitors.filter(monitor => !monitor.errorStreak && monitor.lastSuccessAt);
  const attention = monitors.filter(monitor => monitor.errorStreak || !monitor.lastSuccessAt);
  return [
    "Source health",
    monitors.length ? `${healthy.length} of ${monitors.length} sources succeeded on their last scan.${attention.length ? ` ${attention.length} ${attention.length === 1 ? "needs" : "need"} attention.` : ""}` : "No active sources use this delivery route.",
    ...attention.flatMap(monitor => {
      const reason = monitor.lastError ? diagnosticSummary(monitor.lastError) : undefined;
      return [`- ${stripControlText(monitor.name)}: ${monitor.errorStreak ? `scan failed${reason ? ` — ${reason}` : ""}` : "no successful scan yet"}. Last success: ${monitor.lastSuccessAt ? displayTime(monitor.lastSuccessAt, timezone) : "never"}.`];
    }),
    ...(events.length ? ["", "Source updates during this period", ...events.map(event => {
      const name = monitors.find(monitor => monitor.id === event.monitorId)?.name ?? event.monitorId;
      return `- ${displayTime(event.observedAt, timezone)} · ${stripControlText(name)}: ${event.kind === "health_recovered" ? "scans recovered" : stripControlText(event.reason)}.`;
    })] : []),
  ];
}

function diagnosticSummary(value: string): string {
  const line = stripControlText(value).split("\n")[0]!.replace(/^\w*Error:\s*/, "").split(/<(?:!doctype|html|head|body)\b/i)[0]!.trim();
  if (/^[{[]/.test(line)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
        return readableText(stripControlText(parsed.message).split("\n")[0]!);
      }
    } catch { /* Diagnostic payloads are not reader content. */ }
    return "source unavailable; see the dashboard for details";
  }
  return readableText(line) || "source unavailable";
}
