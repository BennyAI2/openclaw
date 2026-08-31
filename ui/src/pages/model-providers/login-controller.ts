import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/model-setup.css";
import { initialWizardValue, type ModelSetupWizardState } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import { renderModelSetupWizard } from "../model-setup/wizard-view.ts";
import type { ModelProviderLoginOption } from "./data.ts";
import type { ModelProviderRowMessage } from "./view.ts";

type ModelProviderLoginControllerOptions = {
  getClient: () => GatewayBrowserClient | null;
  getAgentId: () => string | null;
  canStart: () => boolean;
  refresh: () => Promise<void>;
  setMessage: (key: string, message: ModelProviderRowMessage | null) => void;
};

export class ModelProviderLoginController implements ReactiveController {
  private state: ModelSetupWizardState = { phase: "idle" };
  private value: unknown;
  private cardId: string | null = null;
  private readonly runner: ModelSetupWizardRunner;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: ModelProviderLoginControllerOptions,
  ) {
    host.addController(this);
    this.runner = new ModelSetupWizardRunner({
      getClient: options.getClient,
      getAgentId: options.getAgentId,
      onChange: (next) => {
        const previousStep = this.state.phase === "step" ? this.state.step.id : null;
        this.state = next;
        if (next.phase === "step" && next.step.id !== previousStep) {
          this.value = initialWizardValue(next.step);
        }
        this.host.requestUpdate();
      },
      requestFailedMessage: () => t("modelProviders.login.failed"),
      cancelledMessage: () => t("modelProviders.login.cancelled"),
      sessionExpiredMessage: () => t("modelProviders.login.expired"),
    });
  }

  get busy(): boolean {
    return this.state.phase !== "idle";
  }

  start(cardId: string, option: ModelProviderLoginOption): void {
    if (!this.options.canStart() || this.busy) {
      return;
    }
    this.cardId = cardId;
    this.options.setMessage(cardId, null);
    void this.runner
      .start(option.id, "models.authLogin.start")
      .then((completion) => this.finish(completion));
  }

  reset(): void {
    this.cardId = null;
    void this.runner.cancel();
  }

  hostDisconnected(): void {
    this.reset();
  }

  render() {
    return renderModelSetupWizard({
      mode: "auth",
      state: this.state,
      refreshWarning: null,
      value: this.value,
      onValueChange: (value) => {
        this.value = value;
        this.host.requestUpdate();
      },
      onAnswer: (value, includeValue) => {
        void this.runner.answer(value, includeValue).then((completion) => this.finish(completion));
      },
      onCancel: () => {
        this.cardId = null;
        void this.runner.cancel();
      },
      onClose: () => this.reset(),
    });
  }

  private async finish(completion: ModelSetupWizardCompletion | null) {
    if (!completion || completion.startMethod !== "models.authLogin.start") {
      return;
    }
    const cardId = this.cardId;
    this.cardId = null;
    this.runner.close();
    this.state = { phase: "idle" };
    await this.options.refresh();
    if (cardId) {
      this.options.setMessage(cardId, {
        kind: "success",
        text: t("modelProviders.login.done"),
      });
    }
    this.host.requestUpdate();
  }
}
