import { Layout as BaseLayout } from "@rspress/core/theme-original";
import "./styles.css";

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

export const Layout = () => <BaseLayout afterHero={<FlowPreview />} />;

export * from "@rspress/core/theme-original";
