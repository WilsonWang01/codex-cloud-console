import { useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & { node?: unknown };
type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };

function MarkdownCode({ className, children }: MarkdownCodeProps) {
  const [copied, setCopied] = useState(false);
  const codeText = String(children ?? "").replace(/\n$/, "");
  const language = /language-([\w-]+)/.exec(className || "")?.[1] || "";
  const block = Boolean(language || codeText.includes("\n"));

  if (!block) return <code>{children}</code>;

  const fallbackCopy = () => {
    const textarea = document.createElement("textarea");
    textarea.value = codeText;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  };

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(codeText);
      } else {
        fallbackCopy();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      try {
        fallbackCopy();
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      } catch {
        setCopied(false);
      }
    }
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-head">
        <span>{language || "text"}</span>
        <button className="text-button compact" type="button" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code className={className}>{codeText}</code>
      </pre>
    </div>
  );
}

function MarkdownLink({ href, children }: MarkdownAnchorProps) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const chatMarkdownComponents: Components = {
  a: MarkdownLink,
  code: MarkdownCode,
};

export default function ChatMarkdownRenderer({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
        {text}
      </ReactMarkdown>
      {streaming && <span className="stream-cursor" />}
    </div>
  );
}
