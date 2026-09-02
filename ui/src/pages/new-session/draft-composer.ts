import { html, nothing, type TemplateResult } from "lit";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { refreshSlashCommands } from "../chat/chat-commands.ts";
import type { CapabilityMenuProps } from "../chat/components/chat-composer-types.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionComposerTextareaController, renderNewSessionComposer } from "./composer.ts";
import { isWorktreeNameValid, type NewSessionVisibility } from "./create-params.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import type { NewSessionModelControl } from "./model-control.ts";

function renderDraftError(message: string, action?: { label: string; onClick: () => void }) {
  return html`
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span class="callout__content new-session-page__alert-message"
        >${formatUiError(message)}</span
      >
      ${action
        ? html`<button class="btn btn--sm" type="button" @click=${action.onClick}>
            ${action.label}
          </button>`
        : nothing}
    </div>
  `;
}

export function renderNewSessionDraftErrors(
  place: Pick<DraftPlaceState, "worktree" | "worktreeName">,
  submission: Pick<
    DraftSubmissionFlow,
    "error" | "submissionOutcomeUnknown" | "pendingPlacement" | "clearPendingPlacementRecovery"
  >,
) {
  const worktreeNameInvalid = place.worktree && !isWorktreeNameValid(place.worktreeName);
  return html`
    ${worktreeNameInvalid ? renderDraftError(t("newSession.worktreeNameInvalid")) : nothing}
    ${submission.error ? renderDraftError(submission.error) : nothing}
    ${submission.submissionOutcomeUnknown
      ? renderDraftError(
          t(
            submission.submissionOutcomeUnknown === "gateway-changed"
              ? "newSession.createOutcomeUnknown"
              : "newSession.placementSetupInterrupted",
          ),
          submission.pendingPlacement.sessionKey
            ? {
                label: t("common.reset"),
                onClick: () => submission.clearPendingPlacementRecovery(),
              }
            : undefined,
        )
      : nothing}
  `;
}

export function renderNewSessionDraftComposer(options: {
  agent?: GatewayAgentRow;
  agentId: string;
  attachmentDraft: NewSessionAttachmentDraft;
  canSubmit: boolean;
  context: ApplicationContext | undefined;
  draftOwnerKey: string;
  isCatalogTarget: boolean;
  message: string;
  mentions?: readonly HumanMention[];
  getMentions?: () => readonly HumanMention[];
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: CapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  modelControl: NewSessionModelControl;
  permissionControl?: TemplateResult;
  textareaController: NewSessionComposerTextareaController;
  voiceControl?: TemplateResult | typeof nothing;
  requiresModifier: boolean;
  requestUpdate: () => void;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  dictationActive?: boolean;
  dictationPreview?: string;
  dictationStatus?: TemplateResult | typeof nothing;
  terminalAction?: {
    canStart: boolean;
    disabledReason?: string;
    onStart: () => void;
  };
  submitting: boolean;
  messageLocked?: boolean;
  onInput: (message: string, mentions?: readonly HumanMention[]) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
  onBackgroundSubmit?: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  const commandClient = options.context?.gateway.snapshot.client ?? null;
  const gateway = options.context?.gateway;
  const profile = gateway?.snapshot.selfUser?.identity;
  const mentionDirectory =
    commandClient &&
    gateway?.snapshot.phase === "connected" &&
    profile?.type === "profile" &&
    hasOperatorWriteAccess(gateway.snapshot.hello?.auth ?? null) &&
    !options.isCatalogTarget &&
    options.visibility !== "incognito"
      ? {
          client: commandClient,
          ownerKey: JSON.stringify([
            gateway.connectionRevision,
            commandClient.recoveryScope,
            profile.id,
            options.draftOwnerKey,
          ]),
          params: {
            agentId: options.agentId,
            ...(options.visibility === "draft" ? { visibility: "draft" as const } : {}),
          },
        }
      : undefined;
  options.textareaController.syncSkillCommandOwner(
    commandClient,
    options.agentId,
    options.draftOwnerKey,
  );
  return renderNewSessionComposer({
    attachmentLimits: options.context?.gateway.snapshot.hello?.policy?.attachments,
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    getAttachments: () => options.attachmentDraft.attachments,
    message: options.message,
    mentions: options.mentions,
    getMentions: options.getMentions,
    mentionDirectory,
    visibility: options.visibility,
    draftAvailable: options.draftAvailable,
    capabilityMenu: options.capabilityMenu,
    toolOverrides: options.toolOverrides,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agent: options.agent,
          agentId: options.agentId,
          context: options.context,
          sending: options.submitting,
        }),
    permissionControl: options.permissionControl,
    pendingAttachmentReads: options.attachmentDraft.pendingReads,
    readSignal,
    requiresModifier: options.requiresModifier,
    requestUpdate: options.requestUpdate,
    refreshCommands: commandClient
      ? () =>
          refreshSlashCommands({
            client: commandClient,
            agentId: options.agentId,
            shouldApply: () =>
              options.textareaController.ownsSkillCommands(
                commandClient,
                options.agentId,
                options.draftOwnerKey,
              ),
          })
      : undefined,
    submitDisabledReason: options.submitDisabledReason,
    blockedSubmitNotice: options.blockedSubmitNotice,
    dictationActive: options.dictationActive,
    dictationPreview: options.dictationPreview,
    dictationStatus: options.dictationStatus,
    terminalAction: options.terminalAction,
    submitting: options.submitting,
    textareaController: options.textareaController,
    voiceControl: options.voiceControl,
    messageLocked: options.messageLocked,
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
    onInput: options.onInput,
    onOpenImage: options.onOpenImage,
    onVisibilityChange: options.onVisibilityChange,
    onSubmit: options.onSubmit,
    onBackgroundSubmit: options.onBackgroundSubmit,
  });
}
