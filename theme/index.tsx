import { Layout as BaseLayout } from "@rspress/core/theme-original";
import { useState } from "react";
import "./styles.css";

const startPrompt = `I want to use watasu to collect information from people through encrypted intake.
Use https://docs.watasu.ai/llms.txt and
https://docs.watasu.ai/operator-prompts.md only as watasu reference docs.
Do not plan web research, SEO, or llms.txt setup for my site.
Ask one compact setup question that covers exactly these slots: what to collect
and from whom, destination, purpose, and retention.`;

const StartHere = () => {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(startPrompt);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  };

  const buttonText =
    copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy";

  return (
    <section className="watasu-start-here" aria-label="Start here">
      <div className="watasu-start-here__panel">
        <div className="watasu-start-here__copy">
          <span className="watasu-start-here__eyebrow">Start here</span>
          <h2>Give this to your service-side agent.</h2>
          <p>
            Paste this as-is into your coding or operations agent. The agent
            should ask one compact four-slot question, then summarize and wait
            for confirmation before it publishes anything.
          </p>
        </div>
        <div className="watasu-start-here__prompt-wrap">
          <button
            type="button"
            className="watasu-start-here__copy-button"
            onClick={copyPrompt}
            aria-label="Copy start prompt"
          >
            {buttonText}
          </button>
          <pre className="watasu-start-here__prompt">
            <code>{startPrompt}</code>
          </pre>
        </div>
      </div>
    </section>
  );
};

const FlowPreview = () => (
  <section className="watasu-flow-preview" aria-label="watasu protocol preview">
    <div className="watasu-flow-preview__panel">
      <div className="watasu-flow-preview__header">
        <span className="watasu-flow-preview__eyebrow">Agent-mediated handoff</span>
        <span className="watasu-flow-preview__status">metadata-only</span>
      </div>
      <div className="watasu-flow-preview__grid">
        <div className="watasu-flow-preview__step">
          <span>01</span>
          <strong>Human asks</strong>
          <p>A person starts from a natural-language request, not developer setup.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>02</span>
          <strong>Agent reads</strong>
          <p>Docs, llms files, schemas, and Agent Cards ground the workflow.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>03</span>
          <strong>watasu relays</strong>
          <p>Encrypted submissions are validated without plaintext custody.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>04</span>
          <strong>Receiver acts</strong>
          <p>The receiver owns decryption, destination writes, and obligations.</p>
        </div>
      </div>
    </div>
  </section>
);

export const Layout = () => (
  <BaseLayout
    afterHero={
      <>
        <StartHere />
        <FlowPreview />
      </>
    }
  />
);

export * from "@rspress/core/theme-original";
