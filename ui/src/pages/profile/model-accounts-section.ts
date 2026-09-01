// Model accounts section: per-person OAuth connect and auth-profile linking.
import { html } from "lit";
import type { UserProfileAuthLink } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";

export type ModelAccountsSectionProps = {
  links: UserProfileAuthLink[];
  /** Linking an arbitrary stored credential is operator.admin-only server-side. */
  showManualLink: boolean;
  busy: boolean;
  error: string | null;
  linkDraft: string;
  connectFlow: { connectId: string; url: string; autoCallback: boolean } | null;
  connectRedirectDraft: string;
  claudeTokenDraft: string;
  onLinkDraftInput: (value: string) => void;
  onLink: () => void;
  onUnlink: (provider: string) => void;
  onConnectStart: () => void;
  onConnectRedirectInput: (value: string) => void;
  onConnectComplete: () => void;
  onConnectCancel: () => void;
  onClaudeTokenInput: (value: string) => void;
  onClaudeConnect: () => void;
};

function providerLabel(provider: string): string {
  if (provider === "openai") {
    return t("profilePage.modelAccounts.providerChatgpt");
  }
  if (provider === "anthropic") {
    return t("profilePage.modelAccounts.providerClaude");
  }
  return provider;
}

function inputValue(event: Event): string {
  // SAFETY: each @input listener below is bound to its own text input element.
  return (event.target as HTMLInputElement).value;
}

function renderLinkedRow(props: ModelAccountsSectionProps, link: UserProfileAuthLink) {
  return renderSettingsRow({
    title: html`
      <span class="model-accounts__id">${link.authProfileId}</span>
      <span class="model-accounts__provider">${providerLabel(link.provider)}</span>
    `,
    description: t("profilePage.modelAccounts.linkedDescription"),
    control: html`
      ${renderSettingsStatus({ kind: "ok", label: t("profilePage.modelAccounts.linkedStatus") })}
      <button
        type="button"
        class="btn btn--sm profile-auth-link-unlink"
        ?disabled=${props.busy}
        @click=${() => props.onUnlink(link.provider)}
      >
        ${t("profilePage.modelAccounts.unlinkAction")}
      </button>
    `,
  });
}

function renderChatgptFlow(props: ModelAccountsSectionProps) {
  const flow = props.connectFlow;
  if (!flow) {
    return renderSettingsRow({
      title: t("profilePage.modelAccounts.connectChatgpt"),
      description: t("profilePage.modelAccounts.connectChatgptDescription"),
      control: html`
        <button
          type="button"
          class="btn btn--sm primary profile-auth-connect-start"
          ?disabled=${props.busy}
          @click=${() => props.onConnectStart()}
        >
          ${t("profilePage.modelAccounts.connectAction")}
        </button>
      `,
    });
  }
  return renderSettingsRow({
    title: t("profilePage.modelAccounts.connectChatgpt"),
    description: flow.autoCallback
      ? t("profilePage.modelAccounts.redirectAutoDescription")
      : t("profilePage.modelAccounts.redirectDescription"),
    stacked: true,
    control: html`
      <div class="model-accounts-flow">
        <a
          class="btn primary profile-auth-connect-open"
          href=${flow.url}
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
        >
          ${t("profilePage.modelAccounts.openSignIn")}
        </a>
        <form
          class="model-accounts-form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            props.onConnectComplete();
          }}
        >
          <input
            class="settings-input profile-auth-connect-redirect"
            type="text"
            aria-label=${t("profilePage.modelAccounts.redirectPlaceholder")}
            .value=${props.connectRedirectDraft}
            placeholder=${t("profilePage.modelAccounts.redirectPlaceholder")}
            ?disabled=${props.busy}
            @input=${(event: Event) => props.onConnectRedirectInput(inputValue(event))}
          />
          <button
            type="submit"
            class="btn btn--sm primary profile-auth-connect-finish"
            ?disabled=${props.busy || !props.connectRedirectDraft.trim()}
          >
            ${t("profilePage.modelAccounts.confirmAction")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${props.busy}
            @click=${() => props.onConnectCancel()}
          >
            ${t("profilePage.modelAccounts.cancelAction")}
          </button>
        </form>
        ${flow.autoCallback
          ? html`<span class="model-accounts-hint" aria-live="polite">
              ${t("profilePage.modelAccounts.waitingHint")}
            </span>`
          : ""}
      </div>
    `,
  });
}

function renderManualLinkRow(props: ModelAccountsSectionProps) {
  return renderSettingsRow({
    title: t("profilePage.modelAccounts.inputLabel"),
    description: t("profilePage.modelAccounts.inputDescription"),
    stackedOnNarrow: true,
    control: html`
      <form
        class="model-accounts-form"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onLink();
        }}
      >
        <input
          class="settings-input profile-auth-link-input"
          type="text"
          aria-label=${t("profilePage.modelAccounts.inputLabel")}
          .value=${props.linkDraft}
          placeholder=${t("profilePage.modelAccounts.inputPlaceholder")}
          ?disabled=${props.busy}
          @input=${(event: Event) => props.onLinkDraftInput(inputValue(event))}
        />
        <button
          type="submit"
          class="btn btn--sm profile-auth-link-submit"
          ?disabled=${props.busy || !props.linkDraft.trim()}
        >
          ${t("profilePage.modelAccounts.linkAction")}
        </button>
      </form>
    `,
  });
}

export function renderModelAccountsSection(props: ModelAccountsSectionProps) {
  const rows = html`
    ${props.links.length === 0
      ? renderSettingsEmpty(t("profilePage.modelAccounts.empty"))
      : props.links.map((link) => renderLinkedRow(props, link))}
    ${renderChatgptFlow(props)}
    ${renderSettingsRow({
      title: t("profilePage.modelAccounts.connectClaude"),
      description: t("profilePage.modelAccounts.connectClaudeDescription"),
      stackedOnNarrow: true,
      control: html`
        <form
          class="model-accounts-form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            props.onClaudeConnect();
          }}
        >
          <input
            class="settings-input profile-auth-connect-claude"
            type="text"
            aria-label=${t("profilePage.modelAccounts.connectClaude")}
            .value=${props.claudeTokenDraft}
            placeholder=${t("profilePage.modelAccounts.claudeTokenPlaceholder")}
            ?disabled=${props.busy}
            @input=${(event: Event) => props.onClaudeTokenInput(inputValue(event))}
          />
          <button
            type="submit"
            class="btn btn--sm profile-auth-connect-claude-submit"
            ?disabled=${props.busy || !props.claudeTokenDraft.trim()}
          >
            ${t("profilePage.modelAccounts.connectAction")}
          </button>
        </form>
      `,
    })}
    ${props.showManualLink ? renderManualLinkRow(props) : ""}
    ${props.error
      ? html`<div class="settings-row model-accounts-error" role="alert">
          <span class="settings-row__desc">${props.error}</span>
        </div>`
      : ""}
  `;
  return renderSettingsSection(
    {
      title: t("profilePage.modelAccounts.title"),
      description: t("profilePage.modelAccounts.description"),
    },
    rows,
  );
}
